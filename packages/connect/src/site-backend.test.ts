import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  offboardLocation,
  openControlDb,
  openSiteDb,
  siteDbName,
} from "@locus/db";
import {
  auditLog,
  location,
  member,
  memberLocation,
  organization,
  site,
  siteBackend,
  user,
} from "@locus/db/control";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectError } from "./errors.ts";
import {
  enableSiteBackend,
  removeSiteBackend,
  type SiteBackendDeps,
  siteBackendOf,
  siteBackendOverview,
  siteBackendRows,
} from "./site-backend.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let deps: SiteBackendDeps;
const now = new Date();
const SITE = "6f1d2c3a-0000-4000-8000-000000000001";

const ctx = (userId: string, activeOrganizationId = "agency-a"): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId,
});

async function addMember(userId: string, organizationId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true })
    .onConflictDoNothing();
  await db
    .insert(member)
    .values({ id: `${userId}@${organizationId}`, userId, organizationId, role, createdAt: now });
}

async function addClient(id: string, organizationId: string) {
  await db.insert(location).values({
    id,
    organizationId,
    ghlLocationId: `ghl-${id}`,
    name: id,
    tursoDbName: `db-${id}`,
    tursoDbHostname: `db-${id}.turso.test`,
    status: "active",
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-backend-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "dbs"));
  deps = { db, provisioner };
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
  await addClient("client-1", "agency-a");
  await addClient("client-2", "agency-a");
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "client-1" });
  await db.insert(site).values({ id: SITE, locationId: "client-1" });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("site backend", () => {
  it("gives a site its own database once, for owners and admins only", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    expect(await siteBackendOf(db, client, SITE)).toBeNull();

    const row = await enableSiteBackend(deps, ctx("owner"), client, { siteId: SITE });
    expect(row).toMatchObject({
      siteId: SITE,
      locationId: "client-1",
      tursoDbName: siteDbName(SITE),
    });
    expect(row.tursoDbName).not.toBe("db-client-1");
    expect(await enableSiteBackend(deps, ctx("owner"), client, { siteId: SITE })).toEqual(row);
    expect(await db.select().from(siteBackend)).toHaveLength(1);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "site.backend.enable"));
    expect(audits).toHaveLength(1);

    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    await expect(
      enableSiteBackend(deps, ctx("staff"), staff, { siteId: SITE }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("only reaches the session's client's sites", async () => {
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(
      enableSiteBackend(deps, ctx("owner"), other, { siteId: SITE }),
    ).rejects.toBeInstanceOf(ConnectError);
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    expect(await siteBackendOf(db, other, SITE)).toBeNull();
    await expect(siteBackendOverview(deps, other, SITE)).rejects.toThrow(/doesn't have a database/);
    await expect(
      siteBackendOf(db, { location: owner.location, memberId: "forged" }, SITE),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("shows the site's tables, rows and sign-ups to staff on the client", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    const site = openSiteDb(provisioner.url(row.tursoDbHostname), "x");
    await site.batch([
      `create table "user" (id text primary key, name text, email text not null, email_verified integer not null, created_at integer not null)`,
      `insert into "user" values ('u1', 'Ann', 'ann@example.test', 1, 1760000000000)`,
      `create table notes (id integer primary key, body text)`,
      `insert into notes (body) values ('one'), ('two')`,
    ]);
    site.close();

    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    const overview = await siteBackendOverview(deps, staff, SITE);
    expect(overview.tables.map((t) => [t.name, t.rows])).toEqual([
      ["notes", 2],
      ["user", 1],
    ]);
    expect(overview.users.map((u) => u.email)).toEqual(["ann@example.test"]);

    const page = await siteBackendRows(deps, staff, { siteId: SITE, table: "notes", limit: 1 });
    expect(page).toMatchObject({ total: 2, rows: [{ id: 1, body: "one" }] });
    await expect(
      siteBackendRows(deps, staff, { siteId: SITE, table: "sqlite_master" }),
    ).rejects.toBeInstanceOf(ConnectError);
  });

  it("deletes the database and its row, for owners and admins only", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    await expect(
      removeSiteBackend(deps, ctx("staff"), staff, { siteId: SITE }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);

    await removeSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    expect(await siteBackendOf(db, owner, SITE)).toBeNull();
    await expect(removeSiteBackend(deps, ctx("owner"), owner, { siteId: SITE })).resolves.toBe(
      undefined,
    );
    // The site itself stays a plain website.
    expect(await db.select().from(site).where(eq(site.id, SITE))).toHaveLength(1);
  });

  it("registers a database an earlier attempt created but never saved", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const left = await provisioner.createDatabase(siteDbName(SITE));
    const leftover: SiteBackendDeps = {
      db,
      provisioner: Object.assign(Object.create(provisioner), {
        createDatabase: async () => {
          throw new Error("database with name already exists");
        },
      }),
    };
    const row = await enableSiteBackend(leftover, ctx("owner"), owner, { siteId: SITE });
    expect(row).toMatchObject({ tursoDbName: left.dbName, tursoDbHostname: left.hostname });

    await removeSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    const missing: SiteBackendDeps = {
      db,
      provisioner: Object.assign(Object.create(provisioner), {
        createDatabase: async () => {
          throw new Error("Turso is down");
        },
      }),
    };
    await expect(enableSiteBackend(missing, ctx("owner"), owner, { siteId: SITE })).rejects.toThrow(
      /Turso is down/,
    );
  });

  it("deletes the new database again if registering it fails", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const destroyed: string[] = [];
    const failing: SiteBackendDeps = {
      provisioner: Object.assign(Object.create(provisioner), {
        destroy: async (name: string) => {
          destroyed.push(name);
        },
      }),
      db: new Proxy(db, {
        get(target, key, receiver) {
          if (key === "insert") {
            return () => {
              throw new Error("control database unavailable");
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    await expect(enableSiteBackend(failing, ctx("owner"), owner, { siteId: SITE })).rejects.toThrow(
      /unavailable/,
    );
    expect(destroyed).toEqual([siteDbName(SITE)]);
  });

  it("is never orphaned: deleting its site refuses, and offboarding the client destroys it", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    await db.$client.execute("pragma foreign_keys = on");
    await expect(db.delete(site).where(eq(site.id, SITE))).rejects.toThrow();

    const destroyed: string[] = [];
    await offboardLocation(
      {
        control: db,
        provisioner: Object.assign(Object.create(provisioner), {
          destroy: async (name: string) => {
            destroyed.push(name);
          },
        }),
      },
      "client-1",
    );
    expect(destroyed).toEqual([row.tursoDbName, "db-client-1"]);
    expect(await db.select().from(siteBackend)).toEqual([]);
    expect(await db.select().from(location).where(eq(location.id, "client-1"))).toEqual([]);
  });
});
