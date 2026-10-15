import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlDb, migrateControlDb, openControlDb } from "./client.ts";
import { location, locationSchemaVersion, organization } from "./control/index.ts";
import { offboardLocation, provisionLocation } from "./locations.ts";
import { LocalProvisioner, tenantDbName } from "./provisioner.ts";
import {
  loadTenantMigrations,
  migrateTenants,
  planTenantMigrations,
  type TenantMigration,
} from "./tenant-migrations.ts";

let dir: string;
let control: ControlDb;
let provisioner: LocalProvisioner;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-db-"));
  control = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(control);
  provisioner = new LocalProvisioner(join(dir, "tenants"));
  await control.insert(organization).values({
    id: "org-1",
    name: "Agency",
    slug: "agency",
    createdAt: new Date(),
  });
});

afterEach(async () => {
  control.$client.close();
  await rm(dir, { recursive: true, force: true });
});

async function tables(hostname: string) {
  const client = createClient({ url: provisioner.url(hostname) });
  try {
    const rs = await client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    );
    return rs.rows.map((r) => String(r.name));
  } finally {
    client.close();
  }
}

const m = (name: string): TenantMigration => ({
  hash: `hash-${name}`,
  sql: [`create table ${name} (id text primary key)`],
});

describe("control database", () => {
  it("migrates Better Auth's tables and ours", async () => {
    const rs = await control.$client.execute("select name from sqlite_master where type = 'table'");
    const names = rs.rows.map((r) => String(r.name));
    for (const t of ["user", "organization", "member", "invitation", "location", "member_location"])
      expect(names).toContain(t);
  });

  it("indexes every foreign key", async () => {
    const tableRows = await control.$client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'",
    );
    const missing: string[] = [];
    for (const { name } of tableRows.rows) {
      const fks = await control.$client.execute(`pragma foreign_key_list('${name}')`);
      const indexes = await control.$client.execute(`pragma index_list('${name}')`);
      const leading = new Set<string>();
      for (const idx of indexes.rows) {
        const cols = await control.$client.execute(`pragma index_info('${idx.name}')`);
        const first = cols.rows.find((c) => c.seqno === 0);
        if (first) leading.add(String(first.name));
      }
      const pk = await control.$client.execute(`pragma table_info('${name}')`);
      for (const col of pk.rows) if (col.pk === 1) leading.add(String(col.name));
      for (const fk of fks.rows)
        if (!leading.has(String(fk.from))) missing.push(`${name}.${fk.from}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("tenantDbName", () => {
  it("follows Turso's naming rules and refuses anything else", () => {
    expect(tenantDbName("0F6B-abc")).toBe("loc-0f6b-abc");
    expect(() => tenantDbName("../etc")).toThrow();
    expect(() => tenantDbName("x".repeat(70))).toThrow();
  });
});

describe("provisioning", () => {
  it("registers a client, creates its database on the current schema, and records it", async () => {
    const { id, hostname } = await provisionLocation(
      { control, provisioner },
      { organizationId: "org-1", ghlLocationId: "ghl-a", name: "Client A" },
    );
    expect(await tables(hostname)).toEqual([
      "generation_run",
      "site_blob",
      "site_brief",
      "site_draft_file",
      "site_version",
      "site_version_file",
    ]);

    const [row] = await control.select().from(location).where(eq(location.id, id));
    expect(row?.status).toBe("active");
    expect(row?.tursoDbHostname).toBe(hostname);
    const [version] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, id));
    expect(version?.appliedHashes).toEqual(loadTenantMigrations().map((x) => x.hash));
    expect(version?.lastError).toBeNull();
  });

  it("refuses the same GHL location twice in one agency, and leaves no database behind", async () => {
    const input = { organizationId: "org-1", ghlLocationId: "ghl-a", name: "Client A" };
    await provisionLocation({ control, provisioner }, input);
    await expect(provisionLocation({ control, provisioner }, input)).rejects.toThrow();
    const files = (await import("node:fs/promises")).readdir(provisioner.dir);
    expect((await files).filter((f) => f.endsWith(".db"))).toHaveLength(1);
  });

  it("offboarding deletes the database and the row", async () => {
    const { id, dbName } = await provisionLocation(
      { control, provisioner },
      { organizationId: "org-1", ghlLocationId: "ghl-a", name: "Client A" },
    );
    await offboardLocation({ control, provisioner }, id);
    expect(await control.select().from(location).where(eq(location.id, id))).toEqual([]);
    expect(
      await control
        .select()
        .from(locationSchemaVersion)
        .where(eq(locationSchemaVersion.locationId, id)),
    ).toEqual([]);
    await expect(stat(join(provisioner.dir, `${dbName}.db`))).rejects.toThrow();
  });
});

describe("tenant migration runner", () => {
  it("plans a skipped migration as a gap and flags hashes no file has", () => {
    const plan = planTenantMigrations([m("a"), m("b"), m("c")], ["hash-a", "hash-c", "hash-x"]);
    expect(plan.pending.map((x) => x.hash)).toEqual(["hash-b"]);
    expect(plan.gaps).toEqual(["hash-b"]);
    expect(plan.unknown).toEqual(["hash-x"]);
  });

  it("applies new migrations to every client from the registry", async () => {
    const deps = { control, provisioner, migrations: [m("a")] };
    const one = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-1",
      name: "One",
    });
    const two = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-2",
      name: "Two",
    });

    const reports = await migrateTenants({ ...deps, migrations: [m("a"), m("b")] });
    expect(reports.map((r) => r.applied)).toEqual([["hash-b"], ["hash-b"]]);
    expect(await tables(one.hostname)).toEqual(["a", "b"]);
    expect(await tables(two.hostname)).toEqual(["a", "b"]);

    const again = await migrateTenants({ ...deps, migrations: [m("a"), m("b")] });
    expect(again.map((r) => r.applied)).toEqual([[], []]);
  });

  it("detects and repairs a migration skipped in the middle", async () => {
    const all = [m("a"), m("b"), m("c")];
    const { id, hostname } = await provisionLocation(
      { control, provisioner },
      { organizationId: "org-1", ghlLocationId: "ghl-1", name: "One" },
    );
    // Simulate a tenant that got a and c but missed b: apply a and c by hand.
    await migrateTenants({ control, provisioner, migrations: [all[0] as TenantMigration] });
    const client = createClient({ url: provisioner.url(hostname) });
    await client.execute("create table c (id text primary key)");
    client.close();
    await control
      .update(locationSchemaVersion)
      .set({ appliedHashes: [...loadTenantMigrations().map((x) => x.hash), "hash-a", "hash-c"] })
      .where(eq(locationSchemaVersion.locationId, id));

    const [report] = await migrateTenants({ control, provisioner, migrations: all });
    expect(report?.applied).toEqual(["hash-b"]);
    expect(report?.repaired).toEqual(["hash-b"]);
    expect(await tables(hostname)).toContain("b");
  });

  it("records a failing client's error and carries on with the others", async () => {
    const deps = { control, provisioner, migrations: [] };
    const bad = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-1",
      name: "Bad",
    });
    const good = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-2",
      name: "Good",
    });
    // Make the first client fail: its database already has the table the migration creates.
    const client = createClient({ url: provisioner.url(bad.hostname) });
    await client.execute("create table a (id text primary key)");
    client.close();

    const reports = await migrateTenants({ control, provisioner, migrations: [m("a"), m("b")] });
    const byId = new Map(reports.map((r) => [r.locationId, r]));
    expect(byId.get(bad.id)?.error).toMatch(/already exists/);
    expect(byId.get(bad.id)?.applied).toEqual([]);
    expect(byId.get(good.id)?.applied).toEqual(["hash-a", "hash-b"]);

    const [version] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, bad.id));
    expect(version?.lastError).toMatch(/already exists/);
    expect(version?.appliedHashes).toEqual([]);
  });

  it("records a client whose token can't be minted and carries on with the others", async () => {
    const deps = { control, provisioner, migrations: [] };
    const bad = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-1",
      name: "Bad",
    });
    const good = await provisionLocation(deps, {
      organizationId: "org-1",
      ghlLocationId: "ghl-2",
      name: "Good",
    });
    const failing = Object.create(provisioner) as LocalProvisioner;
    failing.mintToken = async (dbName: string) => {
      if (dbName === bad.dbName) throw new Error("Turso refused");
      return provisioner.mintToken(dbName);
    };

    const reports = await migrateTenants({
      control,
      provisioner: failing,
      migrations: [m("a")],
    });
    const byId = new Map(reports.map((r) => [r.locationId, r]));
    expect(byId.get(bad.id)?.error).toBe("Turso refused");
    expect(byId.get(good.id)?.applied).toEqual(["hash-a"]);
    const [version] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, bad.id));
    expect(version?.lastError).toBe("Turso refused");

    // The next run succeeds and clears the old error.
    await migrateTenants({ control, provisioner, migrations: [m("a")] });
    const [fixed] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, bad.id));
    expect(fixed?.appliedHashes).toContain("hash-a");
    expect(fixed?.lastError).toBeNull();
  });

  it("clears a stale error when a client is already up to date", async () => {
    const { id } = await provisionLocation(
      { control, provisioner, migrations: [m("a")] },
      { organizationId: "org-1", ghlLocationId: "ghl-1", name: "One" },
    );
    await control
      .update(locationSchemaVersion)
      .set({ lastError: "an old failure" })
      .where(eq(locationSchemaVersion.locationId, id));

    const [report] = await migrateTenants({ control, provisioner, migrations: [m("a")] });
    expect(report?.applied).toEqual([]);
    expect(report?.error).toBeUndefined();
    const [version] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, id));
    expect(version?.lastError).toBeNull();
  });

  it("never erases hashes another deploy recorded while it ran", async () => {
    const { id } = await provisionLocation(
      { control, provisioner, migrations: [m("a")] },
      { organizationId: "org-1", ghlLocationId: "ghl-1", name: "One" },
    );
    // While this deploy (which adds b) is migrating, another deploy (which adds c) finishes.
    const racing = Object.create(provisioner) as LocalProvisioner;
    racing.mintToken = async (dbName: string) => {
      await migrateTenants({ control, provisioner, migrations: [m("a"), m("c")] });
      return provisioner.mintToken(dbName);
    };
    const [report] = await migrateTenants({
      control,
      provisioner: racing,
      migrations: [m("a"), m("b")],
    });
    expect(report?.applied).toEqual(["hash-b"]);

    const [version] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, id));
    expect(version?.appliedHashes).toEqual(["hash-a", "hash-c", "hash-b"]);

    // A deploy with an older set then finds nothing to do and leaves the record alone.
    await migrateTenants({ control, provisioner, migrations: [m("a")] });
    const [after] = await control
      .select()
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, id));
    expect(after?.appliedHashes).toEqual(["hash-a", "hash-c", "hash-b"]);
  });
});
