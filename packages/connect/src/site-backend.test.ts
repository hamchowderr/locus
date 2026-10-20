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
  hostConnection,
  location,
  member,
  memberLocation,
  organization,
  site,
  siteBackend,
  user,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectError } from "./errors.ts";
import {
  enableSiteBackend,
  ensureSiteBackendEnv,
  migrateSiteBackend,
  removeSiteBackend,
  type SiteBackendDeps,
  type SiteReleaseDeps,
  siteBackendOf,
  siteBackendOverview,
  siteBackendRows,
  sitesWithBackend,
} from "./site-backend.ts";
import { vercelSecretRef } from "./vercel.ts";

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
      `create table api_tokens (id integer primary key, label text, token text, big integer)`,
      `insert into api_tokens values (1, 'shop', 'sk_live_x', 9007199254740993)`,
    ]);
    site.close();

    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    const overview = await siteBackendOverview(deps, staff, SITE);
    expect(overview.tables.map((t) => [t.name, t.rows])).toEqual([
      ["api_tokens", 1],
      ["notes", 2],
      ["user", 1],
    ]);
    // One read for the overview and a page: secret-looking columns stay hidden, and a number
    // too big for JavaScript comes back whole.
    const both = await siteBackendOverview(deps, staff, SITE, { table: "api_tokens" });
    expect(both.rows?.rows).toEqual([
      { id: 1n, label: "shop", token: "(hidden)", big: 9007199254740993n },
    ]);
    expect(overview.users.map((u) => u.email)).toEqual(["ann@example.test"]);

    const page = await siteBackendRows(deps, staff, { siteId: SITE, table: "notes", limit: 1 });
    expect(page).toMatchObject({ total: 2, rows: [{ id: 1n, body: "one" }] });
    await expect(
      siteBackendRows(deps, staff, { siteId: SITE, table: "sqlite_master" }),
    ).rejects.toBeInstanceOf(ConnectError);
    // Password hashes and session tokens never reach the dashboard.
    for (const table of ["account", "session", "verification", "twoFactor", "jwks"]) {
      await expect(siteBackendRows(deps, staff, { siteId: SITE, table })).rejects.toThrow(
        "That table holds login secrets, so Locus doesn't show its rows.",
      );
    }
    expect(await sitesWithBackend(db, staff)).toEqual(new Set([SITE]));
    expect(await sitesWithBackend(db, await authorizeClient(db, ctx("owner"), "client-2"))).toEqual(
      new Set(),
    );
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

describe("publishing a site with a database", () => {
  const logins = {
    path: "db/migrations/0000_logins.sql",
    content: "create table member (id text primary key, email text not null)",
  };
  const bookings = {
    path: "db/migrations/0001_bookings.sql",
    content:
      "create table booking (id text primary key, member_id text references member(id));\n--> statement-breakpoint\ncreate index booking_member on booking (member_id);",
  };

  type Call = { method: string; path: string; body: unknown };
  let calls: Call[];
  type Env = { id: string; key: string; target: string[]; gitBranch?: string };
  let envs: Env[];
  let postAnswer: (body: unknown) => unknown;
  const live = (key: string): Env => ({ id: `env_${key}`, key, target: ["production"] });

  function release(options: { provisioner?: boolean } = {}): SiteReleaseDeps {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (method === "GET") return new Response(JSON.stringify({ envs }));
      if (method === "DELETE") return new Response("{}");
      return new Response(JSON.stringify(postAnswer(body)), { status: 201 });
    }) as typeof globalThis.fetch;
    return {
      db,
      secrets,
      http: { fetch, apiBaseUrl: "https://api.vercel.test" },
      ...(options.provisioner === false ? {} : { provisioner }),
    };
  }

  let secrets: MemorySecretStore;
  beforeEach(async () => {
    calls = [];
    envs = [];
    postAnswer = (body) => ({ created: body });
    secrets = new MemorySecretStore();
    const secretRef = vercelSecretRef("agency-a");
    await secrets.set(secretRef, JSON.stringify({ accessToken: "vercel-token", teamId: "team_a" }));
    await db.insert(hostConnection).values({
      organizationId: "agency-a",
      provider: "vercel",
      teamId: "team_a",
      secretRef,
      connectedAt: now,
    });
  });

  it("leaves a plain website alone", async () => {
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    await db.update(site).set({ hostProjectId: "prj_1" }).where(eq(site.id, SITE));
    const page = { path: "app/page.tsx", content: "export default 1" };
    expect(await migrateSiteBackend(release(), staff, { siteId: SITE, files: [page] })).toBeNull();
    expect(await db.select().from(siteBackend)).toEqual([]);
    expect(await ensureSiteBackendEnv(release(), staff, { siteId: SITE })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("applies each new database change once, before the version goes out", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    // Staff on the client publish as they save in the chat.
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    const files = [logins, { path: "app/page.tsx", content: "export default 1" }];
    expect(await migrateSiteBackend(release(), staff, { siteId: SITE, files })).toEqual({
      applied: ["0000_logins"],
    });
    expect(
      await migrateSiteBackend(release(), staff, { siteId: SITE, files: [...files, bookings] }),
    ).toEqual({ applied: ["0001_bookings"] });
    expect(
      await migrateSiteBackend(release(), staff, { siteId: SITE, files: [logins, bookings] }),
    ).toEqual({ applied: [] });

    const db2 = openSiteDb(provisioner.url(row.tursoDbHostname), "x");
    const tables = await db2.execute("select name from sqlite_master where type = 'table'");
    expect(tables.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["member", "booking", "_locus_migrations"]),
    );
    db2.close();
  });

  it("stops the publish when a change fails, and says why", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    const broken = { path: "db/migrations/0000_logins.sql", content: "create tabel member (id)" };
    await expect(
      migrateSiteBackend(release(), owner, { siteId: SITE, files: [broken] }),
    ).rejects.toThrow(
      /^The site's database change didn't apply: 0000_logins failed: .*fix it in place\./,
    );
    // It rolled back, so fixing that same file is what makes the next publish go out.
    expect(await migrateSiteBackend(release(), owner, { siteId: SITE, files: [logins] })).toEqual({
      applied: ["0000_logins"],
    });
    await expect(
      migrateSiteBackend(release({ provisioner: false }), owner, { siteId: SITE, files: [logins] }),
    ).rejects.toThrow("This site's database isn't set up on this deployment yet.");
  });

  it("gives the site's project its database settings once, as sensitive values", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    // No project yet: nothing to set.
    expect(await ensureSiteBackendEnv(release(), owner, { siteId: SITE })).toEqual([]);
    expect(calls).toEqual([]);

    await db.update(site).set({ hostProjectId: "prj_1" }).where(eq(site.id, SITE));
    const added = await ensureSiteBackendEnv(release(), owner, { siteId: SITE });
    expect(added).toEqual(["SITE_DATABASE_URL", "SITE_DATABASE_TOKEN", "SITE_AUTH_SECRET"]);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/v10/projects/prj_1/env");
    const body = post?.body as { key: string; value: string; type: string; target: string[] }[];
    expect(body.map((v) => [v.key, v.type, v.target])).toEqual([
      ["SITE_DATABASE_URL", "sensitive", ["production"]],
      ["SITE_DATABASE_TOKEN", "sensitive", ["production"]],
      ["SITE_AUTH_SECRET", "sensitive", ["production"]],
    ]);
    expect(body[0]?.value).toBe(provisioner.url(row.tursoDbHostname));
    expect(body[2]?.value).toMatch(/^[\w-]{43}$/);

    // Already there: left alone, and the secret is never replaced.
    calls = [];
    envs = ["SITE_DATABASE_URL", "SITE_DATABASE_TOKEN", "SITE_AUTH_SECRET"].map(live);
    expect(await ensureSiteBackendEnv(release(), owner, { siteId: SITE })).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);

    // Once Locus has file storage, the next publish adds the site's files key, and only that.
    calls = [];
    const withFiles = { ...release(), siteFilesKey: (id: string) => `key-for-${id}` };
    expect(await ensureSiteBackendEnv(withFiles, owner, { siteId: SITE })).toEqual([
      "SITE_FILES_KEY",
    ]);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual([
      {
        key: "SITE_FILES_KEY",
        value: `key-for-${SITE}`,
        type: "sensitive",
        target: ["production"],
      },
    ]);

    // Another client's staff can't reach it.
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    expect(await ensureSiteBackendEnv(release(), other, { siteId: SITE })).toEqual([]);
  });

  it("only counts settings the live site reads, and notices ones Vercel refused", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    await db.update(site).set({ hostProjectId: "prj_1" }).where(eq(site.id, SITE));
    // Someone's development-only or one-branch values don't reach production.
    envs = [
      { id: "e1", key: "SITE_DATABASE_URL", target: ["development"] },
      { id: "e2", key: "SITE_DATABASE_TOKEN", target: ["production"], gitBranch: "test" },
      live("SITE_AUTH_SECRET"),
    ];
    expect(await ensureSiteBackendEnv(release(), owner, { siteId: SITE })).toEqual([
      "SITE_DATABASE_URL",
      "SITE_DATABASE_TOKEN",
    ]);

    postAnswer = () => ({ created: [], failed: [{ error: { code: "ENV_CONFLICT" } }] });
    await expect(ensureSiteBackendEnv(release(), owner, { siteId: SITE })).rejects.toThrow(
      "Vercel didn't take the site's database settings. Try again.",
    );
  });

  it("takes the database settings off the project when the database goes", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    await db.update(site).set({ hostProjectId: "prj_1" }).where(eq(site.id, SITE));
    envs = [
      ...["SITE_DATABASE_URL", "SITE_DATABASE_TOKEN", "SITE_AUTH_SECRET"].map(live),
      { id: "other", key: "NEXT_PUBLIC_THEME", target: ["production"] },
    ];
    await removeSiteBackend({ ...release(), provisioner }, ctx("owner"), owner, { siteId: SITE });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/v9/projects/prj_1/env/env_SITE_DATABASE_URL",
      "/v9/projects/prj_1/env/env_SITE_DATABASE_TOKEN",
      "/v9/projects/prj_1/env/env_SITE_AUTH_SECRET",
    ]);
    expect(await siteBackendOf(db, owner, SITE)).toBeNull();
  });

  it("gives a site its database the first time a version with migrations is published", async () => {
    // Staff on the client publish as they save in the chat; the agent made it app-style.
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    expect(
      await migrateSiteBackend(release(), staff, { siteId: SITE, files: [logins, bookings] }),
    ).toEqual({ applied: ["0000_logins", "0001_bookings"] });
    const row = await siteBackendOf(db, staff, SITE);
    expect(row).toMatchObject({ siteId: SITE, tursoDbName: siteDbName(SITE) });
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "site.backend.enable"));
    expect(audits).toMatchObject([
      { actorUserId: null, locationId: "client-1", detail: { memberId: staff.memberId } },
    ]);

    // Another client's staff can't make one for this site.
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(
      migrateSiteBackend(release(), other, { siteId: SITE, files: [logins] }),
    ).rejects.toBeInstanceOf(ConnectError);

    // A badly named migration stops the publish before anything is made.
    await expect(
      migrateSiteBackend(release(), staff, {
        siteId: SITE,
        files: [{ path: "db/migrations/bookings.sql", content: "select 1" }],
      }),
    ).rejects.toThrow(
      /^The site's database change didn't apply: db\/migrations\/bookings\.sql.*Rename the file/,
    );
  });

  it("doesn't make the database again after an owner removed it", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    await migrateSiteBackend(release(), owner, { siteId: SITE, files: [logins] });
    await removeSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    await expect(
      migrateSiteBackend(release(), owner, { siteId: SITE, files: [logins] }),
    ).rejects.toThrow(/^This site's database was removed/);
    expect(await siteBackendOf(db, owner, SITE)).toBeNull();

    // An owner turning it on again is a choice, and publishing works from there.
    await enableSiteBackend(deps, ctx("owner"), owner, { siteId: SITE });
    expect(await migrateSiteBackend(release(), owner, { siteId: SITE, files: [logins] })).toEqual({
      applied: ["0000_logins"],
    });
  });
});
