import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import {
  auditLog,
  hostConnection,
  location,
  member,
  memberLocation,
  organization,
  site,
  user,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectError } from "./errors.ts";
import {
  attachSiteDomain,
  linkHostProject,
  listHostProjects,
  listSites,
  normalizeDomain,
  removeSiteDomain,
  type SiteDeps,
  siteDomainStatus,
  unlinkHostProject,
} from "./sites.ts";
import { createStubVercel, STUB_VERCEL_PROJECT, STUB_VERCEL_TEAM } from "./stub-hosts.ts";
import { vercelSecretRef } from "./vercel.ts";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
const now = new Date();

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

async function connectHost(organizationId: string, teamId: string | null = STUB_VERCEL_TEAM.id) {
  const secretRef = vercelSecretRef(organizationId);
  await secrets.set(
    secretRef,
    JSON.stringify({
      accessToken: "vercel-stub-token",
      teamId,
      userId: "user_stub",
      configurationId: "icfg_stub",
    }),
  );
  await db.insert(hostConnection).values({
    organizationId,
    provider: "vercel",
    teamId: teamId ?? "user_stub",
    secretRef,
    connectedAt: now,
  });
}

type Call = { method: string; url: URL; body: unknown };

/** Answers each Vercel call from `routes` ("METHOD /path"), recording every request. */
function fakeVercel(routes: Record<string, (call: Call) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer vercel-stub-token");
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    const [status, body] = route ? route(call) : [404, { error: { code: "not_found" } }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const deps = (fetch: typeof globalThis.fetch = createStubVercel()): SiteDeps => ({
  db,
  secrets,
  http: { fetch, apiBaseUrl: "https://api.vercel.test" },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-sites-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
  await addMember("other-owner", "agency-b", "owner");
  await addClient("client-1", "agency-a");
  await addClient("client-2", "agency-a");
  await addClient("client-b", "agency-b");
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "client-1" });
  await connectHost("agency-a");
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("domain names", () => {
  it("cleans what people paste", () => {
    expect(normalizeDomain("  https://WWW.Example.com/about?x=1 ")).toBe("www.example.com");
    expect(normalizeDomain("shop.example.co.uk.")).toBe("shop.example.co.uk");
    expect(normalizeDomain("example.com:443")).toBe("example.com");
    expect(normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("refuses what isn't a public hostname", () => {
    for (const bad of ["", "localhost", "exa mple.com", "-bad.com", "1.2.3.4", "a..com"]) {
      expect(() => normalizeDomain(bad)).toThrow(ConnectError);
    }
    expect(() => normalizeDomain("my-site.vercel.app")).toThrow(/already a Vercel address/);
  });
});

describe("linking a Vercel project to a client", () => {
  it("lists the team's projects, asking on behalf of the connected team", async () => {
    const fake = fakeVercel({
      "GET /v10/projects": () => [200, { projects: [{ id: "prj_1", name: "acme", extra: 1 }] }],
    });
    expect(await listHostProjects(deps(fake.fetch), ctx("owner"))).toEqual([
      { id: "prj_1", name: "acme" },
    ]);
    expect(fake.calls[0]?.url.searchParams.get("teamId")).toBe(STUB_VERCEL_TEAM.id);
  });

  it("leaves teamId off for a personal account", async () => {
    await db.delete(hostConnection);
    await connectHost("agency-a", null);
    const fake = fakeVercel({ "GET /v10/projects": () => [200, { projects: [] }] });
    await listHostProjects(deps(fake.fetch), ctx("owner"));
    expect(fake.calls[0]?.url.searchParams.has("teamId")).toBe(false);
  });

  it("makes the project the client's site, once", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await linkHostProject(deps(), ctx("owner"), client, {
      projectId: STUB_VERCEL_PROJECT.id,
    });
    expect(row).toMatchObject({
      locationId: "client-1",
      host: "vercel",
      hostProjectId: STUB_VERCEL_PROJECT.id,
      customDomain: null,
    });
    expect(await listSites(db, client)).toHaveLength(1);
    await expect(
      linkHostProject(deps(), ctx("owner"), client, { projectId: STUB_VERCEL_PROJECT.id }),
    ).rejects.toThrow(/already this client's site/);

    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(
      linkHostProject(deps(), ctx("owner"), other, { projectId: STUB_VERCEL_PROJECT.id }),
    ).rejects.toThrow(/already another site/);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "site.link"));
    expect(entry).toMatchObject({ actorUserId: "owner", locationId: "client-1" });
  });

  it("follows Vercel's pages when listing projects", async () => {
    const fake = fakeVercel({
      "GET /v10/projects": (call) =>
        call.url.searchParams.get("until") === "1700"
          ? [200, { projects: [{ id: "prj_old", name: "old" }], pagination: { next: null } }]
          : [200, { projects: [{ id: "prj_new", name: "new" }], pagination: { next: 1700 } }],
    });
    expect((await listHostProjects(deps(fake.fetch), ctx("owner"))).map((p) => p.id)).toEqual([
      "prj_new",
      "prj_old",
    ]);
  });

  it("holds one site per project in the database too, for agencies sharing a team", async () => {
    await expect(
      db.insert(site).values([
        { id: "s1", locationId: "client-1", host: "vercel", hostProjectId: "prj_x" },
        { id: "s2", locationId: "client-b", host: "vercel", hostProjectId: "prj_x" },
      ]),
    ).rejects.toThrow();
    await connectHost("agency-b");
    const other = await authorizeClient(db, ctx("other-owner", "agency-b"), "client-b");
    const mine = await authorizeClient(db, ctx("owner"), "client-1");
    await linkHostProject(deps(), ctx("owner"), mine, { projectId: STUB_VERCEL_PROJECT.id });
    await expect(
      linkHostProject(deps(), ctx("other-owner", "agency-b"), other, {
        projectId: STUB_VERCEL_PROJECT.id,
      }),
    ).rejects.toThrow(/already another site/);
  });

  it("refuses a project that isn't on the agency's team", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      linkHostProject(deps(), ctx("owner"), client, { projectId: "prj_someone_else" }),
    ).rejects.toThrow(/isn't on your Vercel team/);
    expect(await db.select().from(site)).toHaveLength(0);
  });

  it("unlinks a project, once its domain is gone, without asking Vercel", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await linkHostProject(deps(), ctx("owner"), client, {
      projectId: STUB_VERCEL_PROJECT.id,
    });
    await db.update(site).set({ customDomain: "acme.example" }).where(eq(site.id, row.id));
    const fake = fakeVercel({});
    await expect(unlinkHostProject(deps(fake.fetch), ctx("owner"), client, row.id)).rejects.toThrow(
      /Remove acme.example/,
    );

    await db.update(site).set({ customDomain: null }).where(eq(site.id, row.id));
    await unlinkHostProject(deps(fake.fetch), ctx("owner"), client, row.id);
    expect(await listSites(db, client)).toEqual([]);
    expect(fake.calls).toEqual([]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "site.unlink"));
    expect(entry).toMatchObject({ actorUserId: "owner", locationId: "client-1" });
    // The project can be linked again.
    await linkHostProject(deps(), ctx("owner"), client, { projectId: STUB_VERCEL_PROJECT.id });
  });

  it("keeps a site with a repository when its project is unlinked", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await linkHostProject(deps(), ctx("owner"), client, {
      projectId: STUB_VERCEL_PROJECT.id,
    });
    await db.update(site).set({ repoFullName: "acme/site" }).where(eq(site.id, row.id));
    await unlinkHostProject(deps(), ctx("owner"), client, row.id);
    expect(await listSites(db, client)).toEqual([
      expect.objectContaining({ id: row.id, repoFullName: "acme/site", hostProjectId: null }),
    ]);
  });

  it("unlinks only for owners and admins, and only this client's sites", async () => {
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await linkHostProject(deps(), ctx("owner"), owner, {
      projectId: STUB_VERCEL_PROJECT.id,
    });
    const staff = await authorizeClient(db, ctx("staff"), "client-1");
    await expect(unlinkHostProject(deps(), ctx("staff"), staff, row.id)).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(unlinkHostProject(deps(), ctx("owner"), other, row.id)).rejects.toThrow(
      /isn't one of this client's/,
    );
    expect(await listSites(db, owner)).toHaveLength(1);
  });

  it("needs Vercel connected, and an owner or admin", async () => {
    const client = await authorizeClient(db, ctx("staff"), "client-1");
    await expect(
      linkHostProject(deps(), ctx("staff"), client, { projectId: STUB_VERCEL_PROJECT.id }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(listHostProjects(deps(), ctx("other-owner", "agency-b"))).rejects.toThrow(
      /Connect your Vercel team/,
    );
  });
});

describe("a site's domain", () => {
  async function linkedSite(userId = "owner") {
    const client = await authorizeClient(db, ctx(userId), "client-1");
    const owner = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await linkHostProject(deps(stub), ctx("owner"), owner, {
      projectId: STUB_VERCEL_PROJECT.id,
    });
    return { client, siteId: row.id };
  }
  let stub: typeof fetch;
  beforeEach(() => {
    stub = createStubVercel();
  });

  it("attaches, verifies on the next check and goes live, end to end on the stub", async () => {
    const { client, siteId } = await linkedSite();
    const added = await attachSiteDomain(deps(stub), ctx("owner"), client, {
      siteId,
      domain: "https://www.acme.example/",
    });
    // The stub verifies on the first check, and www.acme.example already points at Vercel.
    expect(added).toEqual({ domain: "www.acme.example", state: "live", records: [] });
    const [row] = await db.select().from(site).where(eq(site.id, siteId));
    expect(row?.customDomain).toBe("www.acme.example");
    expect(await siteDomainStatus(deps(stub), client, siteId)).toMatchObject({ state: "live" });
  });

  it("asks for the TXT record while Vercel hasn't verified the domain", async () => {
    const { client, siteId } = await linkedSite();
    const fake = fakeVercel({
      "POST /v10/projects/prj_stub/domains": () => [200, { name: "www.acme.com", verified: false }],
      "GET /v9/projects/prj_stub/domains/www.acme.com": () => [
        200,
        {
          name: "www.acme.com",
          apexName: "acme.com",
          verified: false,
          verification: [
            { type: "TXT", domain: "_vercel.acme.com", value: "vc-domain-verify=x", reason: "r" },
          ],
        },
      ],
      "POST /v9/projects/prj_stub/domains/www.acme.com/verify": () => [
        400,
        { error: { code: "missing_txt_record", message: "No TXT record" } },
      ],
    });
    const status = await attachSiteDomain(deps(fake.fetch), ctx("owner"), client, {
      siteId,
      domain: "www.acme.com",
    });
    expect(status).toEqual({
      domain: "www.acme.com",
      state: "verify",
      records: [
        {
          type: "TXT",
          name: "_vercel",
          value: "vc-domain-verify=x",
          zone: "acme.com",
          why: "verify",
        },
      ],
    });
    expect(fake.calls[0]?.body).toEqual({ name: "www.acme.com" });
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("gives the CNAME for a subdomain and the A record for an apex", async () => {
    const { client, siteId } = await linkedSite();
    const routes = (domain: string, apexName: string) =>
      fakeVercel({
        "POST /v10/projects/prj_stub/domains": () => [200, {}],
        [`GET /v9/projects/prj_stub/domains/${domain}`]: () => [
          200,
          { name: domain, apexName, verified: true },
        ],
        [`GET /v6/domains/${domain}/config`]: (call) => {
          expect(call.url.searchParams.get("projectIdOrName")).toBe("prj_stub");
          return [
            200,
            {
              misconfigured: true,
              recommendedCNAME: [
                { rank: 2, value: "cname.vercel-dns.com." },
                { rank: 1, value: "abc.vercel-dns-017.com." },
              ],
              recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }],
            },
          ];
        },
        [`DELETE /v9/projects/prj_stub/domains/${domain}`]: () => [200, {}],
      });

    const sub = routes("site-test.otakusolutions.io", "otakusolutions.io");
    expect(
      await attachSiteDomain(deps(sub.fetch), ctx("owner"), client, {
        siteId,
        domain: "site-test.otakusolutions.io",
      }),
    ).toMatchObject({
      state: "point",
      records: [
        {
          type: "CNAME",
          name: "site-test",
          value: "abc.vercel-dns-017.com",
          zone: "otakusolutions.io",
        },
      ],
    });
    await removeSiteDomain(deps(sub.fetch), ctx("owner"), client, siteId);

    const apex = routes("acme.com", "acme.com");
    expect(
      await attachSiteDomain(deps(apex.fetch), ctx("owner"), client, {
        siteId,
        domain: "acme.com",
      }),
    ).toMatchObject({
      state: "point",
      records: [{ type: "A", name: "@", value: "216.198.79.1", zone: "acme.com" }],
    });
  });

  it("shows Vercel's reason when the domain belongs to another account", async () => {
    const { client, siteId } = await linkedSite();
    const fake = fakeVercel({
      "POST /v10/projects/prj_stub/domains": () => [
        409,
        {
          error: {
            code: "domain_already_in_use",
            message: "The domain is already assigned to another Vercel project",
          },
        },
      ],
    });
    await expect(
      attachSiteDomain(deps(fake.fetch), ctx("owner"), client, { siteId, domain: "acme.com" }),
    ).rejects.toThrow("Vercel: The domain is already assigned to another Vercel project");
    const [row] = await db.select().from(site).where(eq(site.id, siteId));
    expect(row?.customDomain).toBeNull();
  });

  it("keeps nothing when Vercel refuses and the project doesn't have the domain", async () => {
    const { client, siteId } = await linkedSite();
    const fake = fakeVercel({
      "POST /v10/projects/prj_stub/domains": () => [
        400,
        { error: { code: "invalid_domain", message: "Domain is already reserved" } },
      ],
    });
    await expect(
      attachSiteDomain(deps(fake.fetch), ctx("owner"), client, { siteId, domain: "acme.com" }),
    ).rejects.toThrow("Vercel: Domain is already reserved");
    const [row] = await db.select().from(site).where(eq(site.id, siteId));
    expect(row?.customDomain).toBeNull();
  });

  it("keeps a domain the project already had", async () => {
    const { client, siteId } = await linkedSite();
    const fake = fakeVercel({
      "POST /v10/projects/prj_stub/domains": () => [400, { error: { message: "exists" } }],
      "GET /v9/projects/prj_stub/domains/acme.com": () => [
        200,
        { name: "acme.com", apexName: "acme.com", verified: true },
      ],
      "GET /v6/domains/acme.com/config": () => [200, { misconfigured: false }],
    });
    expect(
      await attachSiteDomain(deps(fake.fetch), ctx("owner"), client, {
        siteId,
        domain: "acme.com",
      }),
    ).toMatchObject({ state: "live" });
  });

  it("keeps one domain per site until it is removed", async () => {
    const { client, siteId } = await linkedSite();
    await attachSiteDomain(deps(stub), ctx("owner"), client, { siteId, domain: "a.acme.example" });
    await expect(
      attachSiteDomain(deps(stub), ctx("owner"), client, { siteId, domain: "b.acme.example" }),
    ).rejects.toThrow(/already uses a.acme.example/);

    await removeSiteDomain(deps(stub), ctx("owner"), client, siteId);
    expect(await siteDomainStatus(deps(stub), client, siteId)).toBeNull();
    await attachSiteDomain(deps(stub), ctx("owner"), client, { siteId, domain: "b.acme.example" });
    const actions = (await db.select().from(auditLog)).map((e) => e.action);
    expect(actions).toEqual([
      "site.link",
      "site.domain.add",
      "site.domain.remove",
      "site.domain.add",
    ]);
  });

  it("lets staff on the client look, but only owners and admins change it", async () => {
    const { client, siteId } = await linkedSite("staff");
    await expect(
      attachSiteDomain(deps(stub), ctx("staff"), client, { siteId, domain: "acme.example" }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    expect(await siteDomainStatus(deps(stub), client, siteId)).toBeNull();
    await expect(removeSiteDomain(deps(stub), ctx("staff"), client, siteId)).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
  });

  it("never reaches another client's site", async () => {
    const { siteId } = await linkedSite();
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(siteDomainStatus(deps(stub), other, siteId)).rejects.toThrow(
      /isn't one of this client's/,
    );
    await expect(
      attachSiteDomain(deps(stub), ctx("owner"), other, { siteId, domain: "acme.example" }),
    ).rejects.toThrow(/isn't one of this client's/);
    expect(await listSites(db, other)).toEqual([]);
  });

  it("refuses a client object that skipped the access check", async () => {
    const { client, siteId } = await linkedSite();
    const forged = { ...client };
    await expect(siteDomainStatus(deps(stub), forged, siteId)).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
  });
});
