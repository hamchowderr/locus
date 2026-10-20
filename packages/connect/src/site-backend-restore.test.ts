import { mkdtemp, rm } from "node:fs/promises";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableSiteBackend, removeSiteBackend, siteBackendOf } from "./site-backend.ts";
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

    // The live site's address and token are replaced, the login secret is kept, and production
    // is deployed again from the site's repository.
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/v9/projects/prj_1/env/env_SITE_DATABASE_URL",
      "/v9/projects/prj_1/env/env_SITE_DATABASE_TOKEN",
    ]);
    const added = calls.find((c) => c.method === "POST" && c.path.endsWith("/env"))?.body as {
      key: string;
      value: string;
      type: string;
    }[];
    expect(added.map((v) => [v.key, v.type])).toEqual([
      ["SITE_DATABASE_URL", "sensitive"],
      ["SITE_DATABASE_TOKEN", "sensitive"],
    ]);
    expect(added[0]?.value).toBe(provisioner.url(now?.tursoDbHostname ?? ""));
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
    expect(await db.select().from(siteBackendRestore)).toEqual([]);
  });

  it("undoes the last restore, and keeps only the latest replaced database", async () => {
    const { owner, row } = await withDatabase();
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const first = (await siteBackendOf(db, owner, SITE))?.tursoDbName ?? "";
    await addMemberRow(first, "bo@example.test");

    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const second = (await siteBackendOf(db, owner, SITE))?.tursoDbName ?? "";
    // The original went when a second restore replaced the first copy.
    expect(await provisioner.findDatabase(row.tursoDbName)).toBeNull();
    expect(await rowsIn(first)).toEqual(["ann@example.test", "bo@example.test"]);

    calls = [];
    expect(await undoSiteBackendRestore(deps(), ctx("owner"), owner, { siteId: SITE })).toEqual({
      redeployed: true,
    });
    expect((await siteBackendOf(db, owner, SITE))?.tursoDbName).toBe(first);
    expect(await provisioner.findDatabase(second)).toBeNull();
    expect(calls.some((c) => c.path === "/v13/deployments")).toBe(true);
    const state = await siteRestoreState(deps(), owner, SITE);
    expect(state?.undo).toBeNull();
    await expect(
      undoSiteBackendRestore(deps(), ctx("owner"), owner, { siteId: SITE }),
    ).rejects.toThrow("There's no restore to undo.");
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

  it("leaves the site as it was when Vercel refuses, and deletes the copy", async () => {
    const { owner, row } = await withDatabase();
    const refusing = deps();
    refusing.http = {
      apiBaseUrl: "https://api.vercel.test",
      fetch: (async (_input: unknown, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? Response.json({ envs })
          : Response.json({ error: { message: "no" } }, { status: 500 })) as typeof fetch,
    };
    clock += 60_000;
    await expect(
      restoreSiteBackend(refusing, ctx("owner"), owner, { siteId: SITE, to: new Date(clock) }),
    ).rejects.toThrow();
    expect((await siteBackendOf(db, owner, SITE))?.tursoDbName).toBe(row.tursoDbName);
    const left = await provisioner.findDatabase(`${siteDbName(SITE)}-r${clock.toString(36)}`);
    expect(left).toBeNull();
    expect(await db.select().from(siteBackendRestore)).toEqual([]);
  });

  it("deletes the kept database with the site's database, and when the client leaves", async () => {
    const { owner, row } = await withDatabase();
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    await removeSiteBackend({ ...deps(), provisioner }, ctx("owner"), owner, { siteId: SITE });
    expect(await provisioner.findDatabase(row.tursoDbName)).toBeNull();
    expect(await db.select().from(siteBackendRestore)).toEqual([]);

    const again = await enableSiteBackend({ db, provisioner }, ctx("owner"), owner, {
      siteId: SITE,
    });
    clock += 60_000;
    await restoreSiteBackend(deps(), ctx("owner"), owner, { siteId: SITE, to: new Date(clock) });
    const current = (await siteBackendOf(db, owner, SITE))?.tursoDbName ?? "";
    await offboardLocation({ control: db, provisioner }, "client-1");
    expect(await provisioner.findDatabase(again.tursoDbName)).toBeNull();
    expect(await provisioner.findDatabase(current)).toBeNull();
    expect(await db.select().from(siteBackendRestore)).toEqual([]);
  });
});
