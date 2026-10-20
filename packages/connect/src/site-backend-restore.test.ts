import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, type SessionContext } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  offboardLocation,
  openControlDb,
  openSiteDb,
  SITE_MIGRATIONS_TABLE,
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
  siteBackendRestore,
  user,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY,
  enableSiteBackend,
  ensureSiteBackendEnv,
  migrateSiteBackend,
  removeSiteBackend,
  siteBackendOf,
} from "./site-backend.ts";
import {
  restoreSiteBackend,
  SITE_RESTORE_WINDOW_MS,
  type SiteRestoreDeps,
  siteRestoreState,
  undoSiteBackendRestore,
} from "./site-backend-restore.ts";
import { vercelSecretRef } from "./vercel.ts";

// The local provisioner copies a database as it is now (a file keeps no history), so these
// tests prove the swap, the undo and the cleanup; Turso's own restore point is its `seed`.

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let secrets: MemorySecretStore;
let clock: number;
type Call = { method: string; path: string; body: unknown };
let calls: Call[];
type Env = { id: string; key: string; target: string[] };
let envs: Env[];
/** Answers 500 to the calls it matches. */
let failing: (method: string, path: string) => boolean;
const SITE = "6f1d2c3a-0000-4000-8000-000000000001";
const live = (key: string): Env => ({ id: `env_${key}`, key, target: ["production"] });

const ctx = (userId: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId: "agency-a",
});

function deps(): SiteRestoreDeps {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (failing(method, url.pathname)) {
      return Response.json({ error: { message: "no" } }, { status: 500 });
    }
    if (method === "GET" && url.pathname.endsWith("/env")) return Response.json({ envs });
    if (method === "GET") {
      return Response.json({ name: "members-club", link: { productionBranch: "main" } });
    }
    if (method === "DELETE") return Response.json({});
    return Response.json({ created: body }, { status: 201 });
  }) as typeof globalThis.fetch;
  return {
    db,
    secrets,
    provisioner,
    http: { fetch, apiBaseUrl: "https://api.vercel.test" },
    now: () => clock,
  };
}

async function rowsIn(dbName: string) {
  const found = await provisioner.findDatabase(dbName);
  if (!found) return null;
  const site = openSiteDb(provisioner.url(found.hostname), "x");
  try {
    const result = await site.execute("select email from member order by email");
    return result.rows.map((r) => r.email);
  } finally {
    site.close();
  }
}

async function addMemberRow(dbName: string, email: string) {
  const found = await provisioner.findDatabase(dbName);
  if (!found) throw new Error(`no ${dbName}`);
  const site = openSiteDb(provisioner.url(found.hostname), "x");
  try {
    await site.execute("create table if not exists member (email text primary key)");
    await site.execute({ sql: "insert into member (email) values (?)", args: [email] });
  } finally {
    site.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-restore-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "dbs"));
  secrets = new MemorySecretStore();
  calls = [];
  failing = () => false;
  envs = ["SITE_DATABASE_URL", "SITE_DATABASE_TOKEN", "SITE_AUTH_SECRET"].map(live);
  clock = Date.now();
  const now = new Date(clock);
  await db.insert(organization).values({ id: "agency-a", name: "a", slug: "a", createdAt: now });
  for (const [id, role] of [
    ["owner", "owner"],
    ["staff", "member"],
  ] as const) {
    await db.insert(user).values({ id, name: id, email: `${id}@agency.test`, emailVerified: true });
    await db.insert(member).values({
      id: `${id}@agency-a`,
      userId: id,
      organizationId: "agency-a",
      role,
      createdAt: now,
    });
  }
  for (const id of ["client-1", "client-2"]) {
    await db.insert(location).values({
      id,
      organizationId: "agency-a",
      ghlLocationId: `ghl-${id}`,
      name: id,
      tursoDbName: `db-${id}`,
      tursoDbHostname: `db-${id}.turso.test`,
      status: "active",
    });
  }
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "client-1" });
  await db.insert(site).values({
    id: SITE,
    locationId: "client-1",
    repoFullName: "agency/members-club",
    hostProjectId: "prj_1",
  });
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

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

async function withDatabase() {
  const owner = await authorizeClient(db, ctx("owner"), "client-1");
  const row = await enableSiteBackend({ db, provisioner }, ctx("owner"), owner, { siteId: SITE });
  await addMemberRow(row.tursoDbName, "ann@example.test");
  return { owner, row };
}

const paths = (method: string) => calls.filter((c) => c.method === method).map((c) => c.path);
const current = async (owner: Awaited<ReturnType<typeof withDatabase>>["owner"]) =>
  (await siteBackendOf(db, owner, SITE))?.tursoDbName ?? "";
const restoreRow = async () => (await db.select().from(siteBackendRestore))[0];

describe("restoring a site's database", () => {
  it("moves the live site onto a restored copy and keeps the one it replaced", async () => {
    const { owner, row } = await withDatabase();
    const state = await siteRestoreState(deps(), owner, SITE);
    expect(state?.undo).toBeNull();
    // A database made a moment ago can only go back to when it was made.
    expect(state?.earliest.getTime()).toBe(row.createdAt.getTime());

    clock += 60_000;
    const answer = await restoreSiteBackend(deps(), ctx("owner"), owner, {
      siteId: SITE,
      to: new Date(clock - 30_000),
    });
    expect(answer).toEqual({ redeployed: true });

    const now = await siteBackendOf(db, owner, SITE);
    expect(now?.tursoDbName).toMatch(new RegExp(`^${siteDbName(SITE)}-r[0-9a-z]+$`));
    expect(await rowsIn(now?.tursoDbName ?? "")).toEqual(["ann@example.test"]);
    // The database it had is kept, untouched.
    expect(await rowsIn(row.tursoDbName)).toEqual(["ann@example.test"]);

    // The live site's address and token change in place (never missing for a moment), the
    // login secret is kept, and production is deployed again from the site's repository.
    expect(paths("DELETE")).toEqual([]);
    expect(paths("PATCH")).toEqual([
      "/v9/projects/prj_1/env/env_SITE_DATABASE_URL",
      "/v9/projects/prj_1/env/env_SITE_DATABASE_TOKEN",
    ]);
    const patched = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    expect(patched[0]).toEqual({
      value: provisioner.url(now?.tursoDbHostname ?? ""),
      type: "sensitive",
      target: ["production"],
    });
    expect(calls.find((c) => c.path === "/v13/deployments")?.body).toMatchObject({
      project: "prj_1",
      target: "production",
      gitSource: { type: "github", org: "agency", repo: "members-club", ref: "main" },
    });

    const after = await siteRestoreState(deps(), owner, SITE);
    expect(after?.undo).toEqual({
      restoredTo: new Date(clock - 30_000),
      restoredAt: new Date(clock),
    });
    // The restored database's history starts now.
    expect(after?.earliest.getTime()).toBe(clock);
    expect((await restoreRow())?.busyUntil).toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "site.backend.restore"));
    expect(audits).toMatchObject([{ actorUserId: "owner", locationId: "client-1" }]);
  });

  it("is for owners and admins, on the session's client, within Turso's history", async () => {
    const { owner } = await withDatabase();
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    clock += 60_000;
    const to = new Date(clock - 1_000);
    await expect(
      restoreSiteBackend(deps(), ctx("staff"), staff, { siteId: SITE, to }),
    ).rejects.toThrow();
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(
      restoreSiteBackend(deps(), ctx("owner"), other, { siteId: SITE, to }),
    ).rejects.toThrow("That site isn't one of this client's.");
    for (const bad of [new Date(clock + 1_000), new Date(clock - 120_000), new Date(Number.NaN)]) {
      await expect(
        restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: bad }),
      ).rejects.toThrow("Choose a moment within the times shown.");
    }
    // Long-lived databases go back as far as Turso keeps history.
    clock += 3 * SITE_RESTORE_WINDOW_MS;
    expect((await siteRestoreState(deps(), owner, SITE))?.earliest.getTime()).toBe(
      clock - SITE_RESTORE_WINDOW_MS,
    );
    expect(calls).toEqual([]);
  });

  it("runs one restore at a time, and publishing waits for it", async () => {
    const { owner } = await withDatabase();
    clock += 60_000;
    const to = new Date(clock);
    const both = await Promise.allSettled([
      restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to }),
      restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.message).toBe(BUSY);
    // Only one copy was made, and the site is on it.
    const files = await readdir(join(dir, "dbs"));
    expect(files.filter((f) => f.endsWith(".db"))).toHaveLength(2);

    await db.update(siteBackendRestore).set({ busyUntil: new Date(Date.now() + 60_000) });
    await expect(migrateSiteBackend(deps(), owner, { siteId: SITE, files: [] })).rejects.toThrow(
      BUSY,
    );
    await expect(
      undoSiteBackendRestore(deps(), ctx("owner"), owner, { siteId: SITE }),
    ).rejects.toThrow(BUSY);
    await expect(
      removeSiteBackend({ ...deps(), provisioner }, ctx("owner"), owner, { siteId: SITE }),
    ).rejects.toThrow(BUSY);
  });

  it("deletes replaced databases only after the deployment using them has gone", async () => {
    const { owner, row } = await withDatabase();
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const first = await current(owner);
    await addMemberRow(first, "bo@example.test");

    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const second = await current(owner);
    // The original is no longer kept for undo, but a deployment may still use it for a while.
    expect(await provisioner.findDatabase(row.tursoDbName)).not.toBeNull();
    expect((await restoreRow())?.retired.map((r) => r.dbName)).toEqual([row.tursoDbName]);

    calls = [];
    expect(await undoSiteBackendRestore(deps(), ctx("owner"), owner, { siteId: SITE })).toEqual({
      redeployed: true,
    });
    expect(await current(owner)).toBe(first);
    expect(await rowsIn(first)).toEqual(["ann@example.test", "bo@example.test"]);
    expect(await provisioner.findDatabase(second)).not.toBeNull();
    expect(paths("POST")).toContain("/v13/deployments");
    expect((await siteRestoreState(deps(), owner, SITE))?.undo).toBeNull();
    await expect(
      undoSiteBackendRestore(deps(), ctx("owner"), owner, { siteId: SITE }),
    ).rejects.toThrow("There's no restore to undo.");

    // Hours later, the next publish deletes them; never the one the site uses.
    clock += 3 * 3_600_000;
    vi.setSystemTime(clock);
    await migrateSiteBackend(deps(), owner, { siteId: SITE, files: [] });
    vi.useRealTimers();
    expect(await provisioner.findDatabase(row.tursoDbName)).toBeNull();
    expect(await provisioner.findDatabase(second)).toBeNull();
    expect(await provisioner.findDatabase(first)).not.toBeNull();
    expect((await restoreRow())?.retired).toEqual([]);
  });

  it("swaps a site that isn't published yet without touching Vercel", async () => {
    const { owner } = await withDatabase();
    await db.update(site).set({ hostProjectId: null }).where(eq(site.id, SITE));
    clock += 60_000;
    expect(
      await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) }),
    ).toEqual({ redeployed: false });
    expect(calls).toEqual([]);
  });

  it("changes nothing when Vercel won't deploy, and puts the settings back", async () => {
    const { owner, row } = await withDatabase();
    failing = (method, path) => method === "POST" && path === "/v13/deployments";
    clock += 60_000;
    await expect(
      restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) }),
    ).rejects.toThrow("Vercel didn't deploy the site again, so nothing changed. Try again.");
    expect(await current(owner)).toBe(row.tursoDbName);
    expect(await provisioner.findDatabase(`${siteDbName(SITE)}-r${clock.toString(36)}`)).toBeNull();
    // Patched to the copy, then back to the database the live site uses.
    const urls = calls
      .filter((c) => c.method === "PATCH" && c.path.endsWith("env_SITE_DATABASE_URL"))
      .map((c) => (c.body as { value: string }).value);
    expect(urls.at(-1)).toBe(provisioner.url(row.tursoDbHostname));
    expect(await restoreRow()).toMatchObject({
      keptDbName: null,
      envStale: false,
      busyUntil: null,
    });
  });

  it("has the next publish rewrite the settings when putting them back failed too", async () => {
    const { owner, row } = await withDatabase();
    // The move to the copy works, the deploy fails, and so does putting the settings back.
    let patches = 0;
    failing = (method, path) =>
      (method === "PATCH" && ++patches > 2) || (method === "POST" && path === "/v13/deployments");
    clock += 60_000;
    await expect(
      restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) }),
    ).rejects.toThrow();
    expect(await current(owner)).toBe(row.tursoDbName);
    expect((await restoreRow())?.envStale).toBe(true);

    failing = () => false;
    calls = [];
    expect(await ensureSiteBackendEnv(deps(), owner, { siteId: SITE })).toEqual([
      "SITE_DATABASE_URL",
      "SITE_DATABASE_TOKEN",
    ]);
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      value: provisioner.url(row.tursoDbHostname),
    });
    expect((await restoreRow())?.envStale).toBe(false);
  });

  it("won't go back to before a change the live site's code needs", async () => {
    const { owner, row } = await withDatabase();
    const site = openSiteDb(provisioner.url(row.tursoDbHostname), "x");
    await site.execute(
      `create table ${SITE_MIGRATIONS_TABLE} (name text primary key, hash text, applied_at integer)`,
    );
    await site.execute(`insert into ${SITE_MIGRATIONS_TABLE} values ('0001_bookings', 'h', 1)`);
    site.close();
    // Turso's copy of an earlier moment, before that change ran.
    const earlier = Object.create(provisioner) as LocalProvisioner;
    earlier.createDatabase = async (name, opts) => {
      const made = await provisioner.createDatabase(name, opts);
      const copy = openSiteDb(provisioner.url(made.hostname), "x");
      await copy.execute(`delete from ${SITE_MIGRATIONS_TABLE}`);
      copy.close();
      return made;
    };
    clock += 60_000;
    await expect(
      restoreSiteBackend({ ...deps(), provisioner: earlier }, ctx("owner"), owner, {
        siteId: SITE,
        to: new Date(clock),
      }),
    ).rejects.toThrow(/didn't have changes the live site needs \(0001_bookings\)/);
    expect(await current(owner)).toBe(row.tursoDbName);
    expect(calls).toEqual([]);
    expect(await provisioner.findDatabase(`${siteDbName(SITE)}-r${clock.toString(36)}`)).toBeNull();
  });

  it("deletes kept and retired databases with the site's database, and when the client leaves", async () => {
    const { owner, row } = await withDatabase();
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const files = async () => (await readdir(join(dir, "dbs"))).filter((f) => f.endsWith(".db"));
    expect(await files()).toHaveLength(3);
    await removeSiteBackend({ ...deps(), provisioner }, ctx("owner"), owner, { siteId: SITE });
    expect(await files()).toEqual([]);
    expect(await db.select().from(siteBackendRestore)).toEqual([]);

    await enableSiteBackend({ db, provisioner }, ctx("owner"), owner, { siteId: SITE });
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    await offboardLocation({ control: db, provisioner }, "client-1");
    expect(await files()).toEqual([]);
    expect(await db.select().from(siteBackendRestore)).toEqual([]);
    expect(row.tursoDbName).toBe(siteDbName(SITE));
  });
});
