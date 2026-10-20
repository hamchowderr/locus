import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSiteTables } from "./site-db.ts";
import {
  applySiteMigrations,
  pendingSiteMigrations,
  SITE_MIGRATIONS_TABLE,
  SiteMigrationError,
  siteMigrationsIn,
} from "./site-migrations.ts";

let dir: string;
let db: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-migrations-"));
  db = createClient({ url: `file:${join(dir, "site.db")}` });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const files = [
  { path: "app/page.tsx", content: "export default 1" },
  {
    path: "db/migrations/0001_notes.sql",
    content: "alter table bookings add column note text;",
  },
  {
    path: "db/migrations/0000_bookings.sql",
    content:
      "create table bookings (id integer primary key, day text not null);\n--> statement-breakpoint\ncreate index bookings_day on bookings (day);",
  },
];

describe("site migrations", () => {
  it("finds the site's migrations in order and checks their names", () => {
    expect(siteMigrationsIn(files).map((m) => m.name)).toEqual(["0000_bookings", "0001_notes"]);
    expect(() => siteMigrationsIn([{ path: "db/migrations/bookings.sql", content: "" }])).toThrow(
      SiteMigrationError,
    );
    expect(() =>
      siteMigrationsIn([
        { path: "db/migrations/0001_a.sql", content: "" },
        { path: "db/migrations/0001_b.sql", content: "" },
      ]),
    ).toThrow(/Two migrations are numbered 0001/);
  });

  it("applies each migration once, in order, and hides its ledger", async () => {
    const migrations = siteMigrationsIn(files);
    expect(await applySiteMigrations(db, migrations)).toEqual({
      applied: ["0000_bookings", "0001_notes"],
    });
    expect(await applySiteMigrations(db, migrations)).toEqual({ applied: [] });
    const tables = await listSiteTables(db);
    expect(tables.map((t) => t.name)).toEqual(["bookings"]);
    expect(tables[0]?.columns.map((c) => c.name)).toEqual(["id", "day", "note"]);
    const ledger = await db.execute(`select name from ${SITE_MIGRATIONS_TABLE} order by name`);
    expect(ledger.rows.map((r) => r.name)).toEqual(["0000_bookings", "0001_notes"]);
  });

  it("refuses a migration edited after it ran", async () => {
    await applySiteMigrations(db, siteMigrationsIn(files));
    const edited = siteMigrationsIn(files).map((m) =>
      m.name === "0001_notes" ? { ...m, sql: `${m.sql}\n-- changed` } : m,
    );
    await expect(pendingSiteMigrations(db, edited)).rejects.toThrow(/changed after it ran/);
  });

  it("leaves a failed migration and the ones after it unapplied", async () => {
    const broken = [
      { name: "0000_ok", sql: "create table a (id integer primary key);" },
      {
        name: "0001_broken",
        sql: "create table b (id integer primary key);\n--> statement-breakpoint\nselect nope from nowhere;",
      },
      { name: "0002_later", sql: "create table c (id integer primary key);" },
    ];
    await expect(applySiteMigrations(db, broken)).rejects.toThrow(/0001_broken failed/);
    expect((await listSiteTables(db)).map((t) => t.name)).toEqual(["a"]);
    expect((await pendingSiteMigrations(db, broken)).map((m) => m.name)).toEqual([
      "0001_broken",
      "0002_later",
    ]);
  });

  it("rebuilds a table without cascade-deleting the rows that refer to it", async () => {
    await applySiteMigrations(db, [
      {
        name: "0000_init",
        sql: "create table parent (id integer primary key);\n--> statement-breakpoint\ncreate table child (id integer primary key, parent_id integer not null references parent(id) on delete cascade);",
      },
    ]);
    await db.batch(["insert into parent values (1)", "insert into child values (1, 1)"]);
    await applySiteMigrations(db, [
      {
        name: "0001_rebuild",
        sql: [
          "PRAGMA foreign_keys=OFF;",
          "create table __new_parent (id integer primary key, label text);",
          "insert into __new_parent (id) select id from parent;",
          "drop table parent;",
          "alter table __new_parent rename to parent;",
          "PRAGMA foreign_keys=ON;",
        ].join("\n--> statement-breakpoint\n"),
      },
    ]);
    const children = await db.execute("select count(*) as n from child");
    expect(Number(children.rows[0]?.n)).toBe(1);
  });
});

describe("publishing at the same time", () => {
  it("treats a migration another publish just applied as done", async () => {
    const migrations = siteMigrationsIn(files);
    // The other publish lands between this one's check and its apply.
    const racing = {
      execute: db.execute.bind(db),
      migrate: async (statements: Parameters<Client["migrate"]>[0]) => {
        await applySiteMigrations(db, migrations);
        return db.migrate(statements);
      },
    } as unknown as Client;
    await expect(applySiteMigrations(racing, migrations)).resolves.toEqual({ applied: [] });
    const ledger = await db.execute(`select name from ${SITE_MIGRATIONS_TABLE} order by name`);
    expect(ledger.rows.map((r) => r.name)).toEqual(["0000_bookings", "0001_notes"]);
  });

  it("leaves a lost connection as it is, not as the migration's fault", async () => {
    const offline = {
      execute: db.execute.bind(db),
      migrate: async () => {
        throw Object.assign(new Error("fetch failed"), { code: "SERVER_ERROR" });
      },
    } as unknown as Client;
    const failure = await applySiteMigrations(offline, siteMigrationsIn(files)).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SiteMigrationError);
  });
});
