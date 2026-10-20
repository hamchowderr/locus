import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProvisioner, siteDbName } from "./provisioner.ts";
import { listSiteTables, listSiteUsers, openSiteDb, readSiteRows } from "./site-db.ts";

let dir: string;
let provisioner: LocalProvisioner;
let db: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-db-"));
  provisioner = new LocalProvisioner(dir);
  const { dbName, hostname } = await provisioner.createDatabase(siteDbName("SITE-1"));
  db = openSiteDb(provisioner.url(hostname), await provisioner.mintToken(dbName));
  await db.batch([
    "create table __drizzle_migrations (id integer primary key, hash text)",
    `create table "user" (id text primary key, name text, email text not null, email_verified integer not null, created_at integer not null)`,
    `create table "account" (id text primary key, userId text not null, password text)`,
    `create table "bookings" (id integer primary key, "when" text not null, note text)`,
    `insert into "user" values ('u1', 'Ann', 'ann@example.test', 1, 1760000000000), ('u2', null, 'bo@example.test', 0, 1760900000000)`,
    `insert into "account" values ('a1', 'u1', 'hashed-secret')`,
    ...Array.from({ length: 7 }, (_, i) => `insert into bookings ("when") values ('day ${i}')`),
  ]);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("siteDbName", () => {
  it("names a site's database after its id", () => {
    expect(siteDbName("2B1E-AA")).toBe("site-2b1e-aa");
    expect(() => siteDbName("a/b")).toThrow();
  });
});

describe("site database reads", () => {
  it("lists the site's own tables with columns and counts, without bookkeeping", async () => {
    const tables = await listSiteTables(db);
    expect(tables.map((t) => t.name)).toEqual(["account", "bookings", "user"]);
    const bookings = tables.find((t) => t.name === "bookings");
    expect(bookings?.rows).toBe(7);
    expect(bookings?.columns).toEqual([
      { name: "id", type: "INTEGER", notNull: false, primaryKey: true },
      { name: "when", type: "TEXT", notNull: true, primaryKey: false },
      { name: "note", type: "TEXT", notNull: false, primaryKey: false },
    ]);
  });

  it("lists a search table once, without the tables its indexes keep", async () => {
    await db.batch([
      "create table post (id integer primary key, title text, embedding F32_BLOB(3))",
      "create index post_embedding_idx on post (libsql_vector_idx(embedding))",
      "create virtual table post_search using fts5(title)",
    ]);
    const names = (await listSiteTables(db)).map((t) => t.name);
    expect(names).toEqual(["account", "bookings", "post", "post_search", "user"]);
  });

  it("pages a table and refuses a name the site doesn't have", async () => {
    const page = await readSiteRows(db, "bookings", { limit: 3, offset: 5 });
    expect(page.total).toBe(7);
    expect(page.columns).toEqual(["id", "when", "note"]);
    expect(page.rows.map((r) => r.when)).toEqual(["day 5", "day 6"]);
    expect((await readSiteRows(db, "bookings", { limit: 10_000 })).rows).toHaveLength(7);
    for (const table of ["missing", `bookings"; drop table bookings; --`, "__drizzle_migrations"]) {
      await expect(readSiteRows(db, table)).rejects.toThrow(/no table/);
    }
    expect((await listSiteTables(db)).map((t) => t.name)).toContain("bookings");
  });

  it("lists sign-ups newest first, without reading passwords", async () => {
    const users = await listSiteUsers(db);
    expect(users).toEqual([
      {
        id: "u2",
        name: null,
        email: "bo@example.test",
        emailVerified: false,
        createdAt: new Date(1760900000000),
      },
      {
        id: "u1",
        name: "Ann",
        email: "ann@example.test",
        emailVerified: true,
        createdAt: new Date(1760000000000),
      },
    ]);
    expect(JSON.stringify(users)).not.toContain("hashed-secret");
  });

  it("reads Better Auth's camel-case columns too", async () => {
    await db.batch([
      `drop table "user"`,
      `create table "user" (id text primary key, email text not null, emailVerified integer, createdAt text)`,
      `insert into "user" values ('u3', 'cy@example.test', 1, '2026-10-01T00:00:00.000Z')`,
    ]);
    expect(await listSiteUsers(db)).toEqual([
      {
        id: "u3",
        name: null,
        email: "cy@example.test",
        emailVerified: true,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    ]);
  });

  it("has no users before the site has logins", async () => {
    await db.execute(`drop table "user"`);
    expect(await listSiteUsers(db)).toEqual([]);
  });

  it("forks a local site database as a copy", async () => {
    const copy = await provisioner.createDatabase("site-copy", {
      fork: { from: siteDbName("SITE-1") },
    });
    const forked = openSiteDb(provisioner.url(copy.hostname), "x");
    try {
      expect((await readSiteRows(forked, "bookings")).total).toBe(7);
    } finally {
      forked.close();
    }
  });
});
