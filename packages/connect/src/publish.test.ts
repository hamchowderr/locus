import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import {
  auditLog,
  githubInstallation,
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
  checkSitePaths,
  commitSiteVersion,
  createAppJwt,
  ensureSiteDeployment,
  ensureSiteRepo,
  type GithubAppCredentials,
  InstallationTokenCache,
  installationToken,
  latestDeployment,
  listInstallationRepos,
  type PublishDeps,
  type SiteFile,
} from "./publish.ts";
import {
  createStubGithub,
  createStubVercel,
  STUB_GITHUB_APP_ID,
  STUB_GITHUB_EMPTY_REPO,
  STUB_GITHUB_INSTALLATION,
  STUB_VERCEL_TEAM,
} from "./stub-hosts.ts";
import { vercelSecretRef } from "./vercel.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let clock: number;
const now = new Date();

const ctx = (userId: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId: "agency-a",
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

async function addSite(
  id: string,
  locationId = "client-1",
  values: Partial<typeof site.$inferInsert> = {},
) {
  await db.insert(site).values({ id, locationId, ...values });
}

const siteRow = async (id: string) => (await db.select().from(site).where(eq(site.id, id)))[0];

type Call = { method: string; url: URL; auth: string | null; body: unknown };
type Route = (call: Call) => [number, unknown];

/** Answers each call from `routes` ("METHOD /path"), recording every request. No network. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call = {
      method,
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    const [status, body] = route ? route(call) : [404, { message: "Not Found" }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  const of = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.url.pathname === path);
  return { calls, fetch, of };
}

let keyReads = 0;
const app = (appId = "Iv23-test"): GithubAppCredentials => ({
  appId,
  privateKey: async () => {
    keyReads++;
    return PEM;
  },
});

const tokenRoute: Route = (call) => {
  const n = (call.body as { repositories?: string[] }).repositories?.join(",") ?? "all";
  return [201, { token: `ghs_${n}`, expires_at: new Date(clock + 60 * 60_000).toISOString() }];
};

function deps(
  options: { github?: typeof fetch; vercel?: typeof fetch; appId?: string } = {},
): PublishDeps {
  return {
    db,
    secrets,
    githubApp: app(options.appId),
    github: {
      fetch: options.github ?? fakeFetch({}).fetch,
      apiBaseUrl: "https://api.github.test",
    },
    http: { fetch: options.vercel ?? fakeFetch({}).fetch, apiBaseUrl: "https://api.vercel.test" },
    tokens: new InstallationTokenCache(),
    now: () => clock,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-publish-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  clock = Date.parse("2026-10-14T12:00:00Z");
  keyReads = 0;
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
  await addClient("client-1", "agency-a");
  await addClient("client-2", "agency-a");
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "client-1" });
  await db.insert(githubInstallation).values({
    organizationId: "agency-a",
    installationId: String(STUB_GITHUB_INSTALLATION.id),
    orgLogin: STUB_GITHUB_INSTALLATION.login,
    connectedAt: now,
  });
  const secretRef = vercelSecretRef("agency-a");
  await secrets.set(
    secretRef,
    JSON.stringify({
      accessToken: "vercel-stub-token",
      teamId: STUB_VERCEL_TEAM.id,
      userId: "user_stub",
      configurationId: "icfg_stub",
    }),
  );
  await db.insert(hostConnection).values({
    organizationId: "agency-a",
    provider: "vercel",
    teamId: STUB_VERCEL_TEAM.id,
    secretRef,
    connectedAt: now,
  });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the GitHub App's JWT", () => {
  it("is RS256, issued 60 seconds ago, short-lived, and verifies with the public key", async () => {
    const jwt = await createAppJwt(app("Iv23-client"), clock);
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toBe("Iv23-client");
    expect(claims.iat).toBe(Math.floor(clock / 1000) - 60);
    expect(claims.exp).toBeGreaterThan(Math.floor(clock / 1000));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(keyReads).toBe(1);
  });
});

describe("installation tokens", () => {
  it("are minted with the app's JWT, scoped as asked, and reused until near expiry", async () => {
    const gh = fakeFetch({ "POST /app/installations/77/access_tokens": tokenRoute });
    const d = deps({ github: gh.fetch });
    const scoped = { repository: "site-one", permissions: { contents: "write" as const } };

    expect(await installationToken(d, "77", scoped)).toBe("ghs_site-one");
    expect(await installationToken(d, "77", scoped)).toBe("ghs_site-one");
    const minted = gh.of("POST", "/app/installations/77/access_tokens");
    expect(minted).toHaveLength(1);
    expect(minted[0]?.body).toEqual({
      repositories: ["site-one"],
      permissions: { contents: "write" },
    });
    expect(minted[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(minted[0]?.url.origin).toBe("https://api.github.test");

    // Another scope is another token.
    await installationToken(d, "77", { permissions: { administration: "write" } });
    expect(gh.of("POST", "/app/installations/77/access_tokens")).toHaveLength(2);

    // Within five minutes of expiry, a fresh one.
    clock += 56 * 60_000;
    await installationToken(d, "77", scoped);
    expect(gh.of("POST", "/app/installations/77/access_tokens")).toHaveLength(3);
  });

  it("never serves a cached token to another repository or another set of permissions", async () => {
    let n = 0;
    const mint: Route = () => [
      201,
      { token: `ghs_${++n}`, expires_at: new Date(clock + 60 * 60_000).toISOString() },
    ];
    const gh = fakeFetch({
      "POST /app/installations/77/access_tokens": mint,
      "POST /app/installations/78/access_tokens": mint,
    });
    const d = deps({ github: gh.fetch });
    const one = await installationToken(d, "77", {
      repository: "site-one",
      permissions: { contents: "write" },
    });
    const two = await installationToken(d, "77", {
      repository: "site-two",
      permissions: { contents: "write" },
    });
    const readOnly = await installationToken(d, "77", {
      repository: "site-one",
      permissions: { contents: "read" },
    });
    const wider = await installationToken(d, "77", {
      repository: "site-one",
      permissions: { contents: "write", administration: "write" },
    });
    const otherInstallation = await installationToken(d, "78", {
      repository: "site-one",
      permissions: { contents: "write" },
    });
    expect(new Set([one, two, readOnly, wider, otherInstallation]).size).toBe(5);
    expect(
      await installationToken(d, "77", {
        repository: "site-one",
        permissions: { contents: "write" },
      }),
    ).toBe(one);
    expect(gh.calls.map((c) => c.body)).toEqual([
      { repositories: ["site-one"], permissions: { contents: "write" } },
      { repositories: ["site-two"], permissions: { contents: "write" } },
      { repositories: ["site-one"], permissions: { contents: "read" } },
      { repositories: ["site-one"], permissions: { contents: "write", administration: "write" } },
      { repositories: ["site-one"], permissions: { contents: "write" } },
    ]);
  });

  it("says when the app is no longer installed", async () => {
    const gh = fakeFetch({});
    await expect(
      installationToken(deps({ github: gh.fetch }), "77", { permissions: { metadata: "read" } }),
    ).rejects.toThrow(/no longer installed/);
  });
});

const installationPath = `/app/installations/${STUB_GITHUB_INSTALLATION.id}`;

describe("giving a site a repository", () => {
  const orgRoutes = (type: "Organization" | "User") => ({
    [`GET ${installationPath}`]: (): [number, unknown] => [
      200,
      { id: STUB_GITHUB_INSTALLATION.id, account: { login: "acme", type } },
    ],
    [`POST ${installationPath}/access_tokens`]: tokenRoute,
    "POST /orgs/acme/repos": (call: Call): [number, unknown] => [
      201,
      { full_name: `acme/${(call.body as { name: string }).name}`, default_branch: "main" },
    ],
  });

  it("creates a private, empty repository in an organization", async () => {
    await addSite("site-1");
    const gh = fakeFetch(orgRoutes("Organization"));
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
      siteId: "site-1",
      name: "acme-dental",
    });
    expect(row.repoFullName).toBe("acme/acme-dental");
    const [create] = gh.of("POST", "/orgs/acme/repos");
    expect(create?.body).toEqual({ name: "acme-dental", private: true, auto_init: false });
    expect(create?.auth).toBe("Bearer ghs_all");
    expect(gh.of("POST", `${installationPath}/access_tokens`)[0]?.body).toEqual({
      permissions: { administration: "write" },
    });
    const audits = await db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(["site.repo.create"]);
    expect(audits[0]?.locationId).toBe("client-1");

    // Once only.
    await ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
      siteId: "site-1",
      name: "other",
    });
    expect(gh.of("POST", "/orgs/acme/repos")).toHaveLength(1);
  });

  it("explains that a personal account needs an empty repository linked instead", async () => {
    await addSite("site-1");
    const gh = fakeFetch(orgRoutes("User"));
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
        siteId: "site-1",
        name: "acme-dental",
      }),
    ).rejects.toThrow(/personal account acme\. Create an empty private repository/);
    expect(gh.of("POST", "/orgs/acme/repos")).toHaveLength(0);
    expect((await siteRow("site-1"))?.repoFullName).toBeNull();
  });

  it("refuses a repository name GitHub wouldn't take, or one that's taken", async () => {
    await addSite("site-1");
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const gh = fakeFetch({
      ...orgRoutes("Organization"),
      "POST /orgs/acme/repos": () => [422, { message: "Repository creation failed." }],
    });
    await expect(
      ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
        siteId: "site-1",
        name: "bad name!",
      }),
    ).rejects.toThrow(/letters, numbers/);
    await expect(
      ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
        siteId: "site-1",
        name: "taken",
      }),
    ).rejects.toThrow(/name is taken/);
  });

  const linkRoutes = (head: [number, unknown], size = 0) => ({
    [`POST ${installationPath}/access_tokens`]: tokenRoute,
    "GET /installation/repositories": (): [number, unknown] => [
      200,
      { total_count: 1, repositories: [{ full_name: "Sam/Acme-Site", private: true }] },
    ],
    "GET /repos/Sam/Acme-Site": (): [number, unknown] => [
      200,
      { full_name: "Sam/Acme-Site", default_branch: "main", size },
    ],
    "GET /repos/Sam/Acme-Site/git/ref/heads/main": (): [number, unknown] => head,
  });

  it("refuses to link a repository that already has files", async () => {
    await addSite("site-1");
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    for (const [head, size] of [
      [[200, { object: { sha: "abc" } }], 0],
      [[404, { message: "Not Found" }], 12],
    ] as [[number, unknown], number][]) {
      const gh = fakeFetch(linkRoutes(head, size));
      await expect(
        ensureSiteRepo(deps({ github: gh.fetch }), ctx("owner"), client, {
          siteId: "site-1",
          repoFullName: "Sam/Acme-Site",
        }),
      ).rejects.toThrow(
        "Sam/Acme-Site already has files, and each save replaces everything in the repository. Pick an empty repository, or create one.",
      );
      // Checked with a read-only token for that repository.
      expect(gh.of("POST", `${installationPath}/access_tokens`)[1]?.body).toEqual({
        repositories: ["Acme-Site"],
        permissions: { contents: "read" },
      });
    }
    expect((await siteRow("site-1"))?.repoFullName).toBeNull();
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("links a repository the installation can see, in any account, once per site", async () => {
    await addSite("site-1");
    await addSite("site-2", "client-2");
    const gh = fakeFetch(linkRoutes([409, { message: "Git Repository is empty." }]));
    const d = deps({ github: gh.fetch });
    expect(await listInstallationRepos(d, ctx("owner"))).toEqual([
      { fullName: "Sam/Acme-Site", private: true },
    ]);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      ensureSiteRepo(d, ctx("owner"), client, { siteId: "site-1", repoFullName: "sam/other" }),
    ).rejects.toThrow(/give the app access/);
    const row = await ensureSiteRepo(d, ctx("owner"), client, {
      siteId: "site-1",
      repoFullName: "sam/acme-site",
    });
    expect(row.repoFullName).toBe("Sam/Acme-Site");
    expect(gh.of("POST", `${installationPath}/access_tokens`)[0]?.body).toEqual({
      permissions: { metadata: "read" },
    });

    const other = await authorizeClient(db, ctx("owner"), "client-2");
    await expect(
      ensureSiteRepo(d, ctx("owner"), other, { siteId: "site-2", repoFullName: "Sam/Acme-Site" }),
    ).rejects.toThrow(/already another site's/);
  });

  it("holds one repository per site, and one site per repository, under concurrent requests", async () => {
    await addSite("site-1");
    await addSite("site-2", "client-2");
    await addSite("site-3");
    const d = deps({ github: createStubGithub(), appId: STUB_GITHUB_APP_ID });
    const c1 = await authorizeClient(db, ctx("owner"), "client-1");
    const c2 = await authorizeClient(db, ctx("owner"), "client-2");

    // Two sites racing for the same repository: one gets it.
    const linked = await Promise.allSettled([
      ensureSiteRepo(d, ctx("owner"), c1, {
        siteId: "site-1",
        repoFullName: STUB_GITHUB_EMPTY_REPO,
      }),
      ensureSiteRepo(d, ctx("owner"), c2, {
        siteId: "site-2",
        repoFullName: STUB_GITHUB_EMPTY_REPO,
      }),
    ]);
    expect(linked.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = linked.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConnectError);
    expect(String(lost.reason)).toMatch(/already another site's/);
    const owners = await db
      .select()
      .from(site)
      .where(eq(site.repoFullName, STUB_GITHUB_EMPTY_REPO));
    expect(owners).toHaveLength(1);

    // One site, two repositories asked for at once: it keeps the first, both callers see it.
    const both = await Promise.all([
      ensureSiteRepo(d, ctx("owner"), c1, { siteId: "site-3", name: "race-a" }),
      ensureSiteRepo(d, ctx("owner"), c1, { siteId: "site-3", name: "race-b" }),
    ]);
    const stored = (await siteRow("site-3"))?.repoFullName;
    expect(stored).toMatch(/\/race-[ab]$/);
    expect(both.map((r) => r.repoFullName)).toEqual([stored, stored]);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "site.repo.create"));
    expect(audits).toHaveLength(1);
  });

  it("refuses a second site on a repository at the database too", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/one" });
    await expect(addSite("site-2", "client-2", { repoFullName: "acme/one" })).rejects.toThrow();
  });

  it("needs GitHub connected", async () => {
    await addSite("site-1");
    await db.delete(githubInstallation);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      ensureSiteRepo(deps(), ctx("owner"), client, { siteId: "site-1", name: "x" }),
    ).rejects.toThrow(/Connect GitHub/);
  });
});

describe("site paths", () => {
  it("refuses paths outside the repository, under .git, and environment files", () => {
    const bad = [
      "../secrets.txt",
      "app/../../x",
      "/etc/passwd",
      "C:/x",
      "a\\b",
      ".git/config",
      "sub/.git/hooks/pre-commit",
      ".env",
      ".env.local",
      "apps/web/.ENV.production",
      "a//b",
      "./a",
      "",
    ];
    for (const path of bad) {
      expect(() => checkSitePaths([{ path, content: "x" }]), path).toThrow(ConnectError);
    }
    expect(() => checkSitePaths([])).toThrow(/no files/);
    expect(() =>
      checkSitePaths([
        { path: "a.ts", content: "" },
        { path: "a.ts", content: "" },
      ]),
    ).toThrow(/twice/);
    expect(() =>
      checkSitePaths([
        { path: "app/page.tsx", content: "" },
        { path: ".gitignore", content: "" },
        { path: "environment.ts", content: "" },
      ]),
    ).not.toThrow();
  });
});

describe("committing a version", () => {
  const repo = "/repos/acme/site-one";
  const files: SiteFile[] = [
    { path: "app/page.tsx", content: "export default function Page() {}" },
    { path: "public/logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
  ];

  function gitRoutes(headStatus: 200 | 404 | 409, extra: Record<string, Route> = {}) {
    return fakeFetch({
      [`POST ${installationPath}/access_tokens`]: tokenRoute,
      [`GET ${repo}`]: () => [200, { full_name: "acme/site-one", default_branch: "main" }],
      [`GET ${repo}/git/ref/heads/main`]: () =>
        headStatus === 200
          ? [200, { ref: "refs/heads/main", object: { sha: "head-1" } }]
          : [
              headStatus,
              { message: headStatus === 409 ? "Git Repository is empty." : "Not Found" },
            ],
      [`POST ${repo}/git/blobs`]: () => [201, { sha: "blob-1" }],
      [`POST ${repo}/git/trees`]: () => [201, { sha: "tree-1" }],
      [`POST ${repo}/git/commits`]: () => [
        201,
        { sha: "commit-1", html_url: "https://github.com/acme/site-one/commit/commit-1" },
      ],
      [`PATCH ${repo}/git/refs/heads/main`]: () => [200, { object: { sha: "commit-1" } }],
      [`POST ${repo}/git/refs`]: () => [201, { object: { sha: "commit-1" } }],
      ...extra,
    });
  }

  beforeEach(async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site-one" });
  });

  it("commits exactly the snapshot on top of the branch, with a repository-scoped token", async () => {
    const gh = gitRoutes(200);
    const client = await authorizeClient(db, ctx("staff"), "client-1");
    const result = await commitSiteVersion(deps({ github: gh.fetch }), client, {
      siteId: "site-1",
      files,
      message: "Version 2",
      parentSha: "head-1",
    });
    expect(result).toEqual({
      commitSha: "commit-1",
      url: "https://github.com/acme/site-one/commit/commit-1",
    });

    expect(gh.of("POST", `${installationPath}/access_tokens`)[0]?.body).toEqual({
      repositories: ["site-one"],
      permissions: { contents: "write" },
    });
    for (const call of gh.calls.filter((c) => c.url.pathname.startsWith(repo))) {
      expect(call.auth).toBe("Bearer ghs_site-one");
    }
    // Binary goes as a base64 blob; text inline in the tree.
    expect(gh.of("POST", `${repo}/git/blobs`).map((c) => c.body)).toEqual([
      {
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString("base64"),
        encoding: "base64",
      },
    ]);
    const tree = gh.of("POST", `${repo}/git/trees`)[0]?.body as Record<string, unknown>;
    expect(tree).not.toHaveProperty("base_tree");
    expect(tree.tree).toEqual([
      {
        path: "app/page.tsx",
        mode: "100644",
        type: "blob",
        content: "export default function Page() {}",
      },
      { path: "public/logo.png", mode: "100644", type: "blob", sha: "blob-1" },
    ]);
    expect(gh.of("POST", `${repo}/git/commits`)[0]?.body).toEqual({
      message: "Version 2",
      tree: "tree-1",
      parents: ["head-1"],
    });
    expect(gh.of("PATCH", `${repo}/git/refs/heads/main`)[0]?.body).toEqual({
      sha: "commit-1",
      force: false,
    });
    expect(gh.of("PUT", `${repo}/contents/app/page.tsx`)).toHaveLength(0);
    expect((await siteRow("site-1"))?.status).toBe("pushed");
    const [entry] = await db.select().from(auditLog);
    expect(entry?.action).toBe("site.commit");
    expect(entry?.detail).toMatchObject({ commitSha: "commit-1", memberId: "staff@agency-a" });
  });

  it("starts an empty repository through the contents API, then commits the snapshot", async () => {
    const gh = gitRoutes(409, {
      [`PUT ${repo}/contents/app/page.tsx`]: () => [201, { commit: { sha: "seed-1" } }],
    });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await commitSiteVersion(deps({ github: gh.fetch }), client, {
      siteId: "site-1",
      files,
      message: "First version",
    });
    const [seed] = gh.of("PUT", `${repo}/contents/app/page.tsx`);
    expect(seed?.body).toEqual({
      message: "First version",
      content: Buffer.from("export default function Page() {}").toString("base64"),
    });
    // Blobs only after the repository has a commit.
    const order = gh.calls.map((c) => `${c.method} ${c.url.pathname}`);
    expect(order.indexOf(`PUT ${repo}/contents/app/page.tsx`)).toBeLessThan(
      order.indexOf(`POST ${repo}/git/blobs`),
    );
    expect(gh.of("POST", `${repo}/git/commits`)[0]?.body).toMatchObject({ parents: ["seed-1"] });
    expect(gh.of("PATCH", `${repo}/git/refs/heads/main`)).toHaveLength(1);
    expect(gh.of("POST", `${repo}/git/refs`)).toHaveLength(0);
  });

  it("creates the branch when the repository has commits but not that branch", async () => {
    const gh = gitRoutes(404);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await commitSiteVersion(deps({ github: gh.fetch }), client, {
      siteId: "site-1",
      files,
      message: "v1",
    });
    expect(gh.of("POST", `${repo}/git/commits`)[0]?.body).toMatchObject({ parents: [] });
    expect(gh.of("POST", `${repo}/git/refs`)[0]?.body).toEqual({
      ref: "refs/heads/main",
      sha: "commit-1",
    });
  });

  it("refuses when the branch moved since the version was started", async () => {
    const gh = gitRoutes(200);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      commitSiteVersion(deps({ github: gh.fetch }), client, {
        siteId: "site-1",
        files,
        message: "v2",
        parentSha: "stale",
      }),
    ).rejects.toThrow(/changed since/);
    expect(gh.of("POST", `${repo}/git/trees`)).toHaveLength(0);

    const raced = gitRoutes(200, {
      [`PATCH ${repo}/git/refs/heads/main`]: () => [
        422,
        { message: "Update is not a fast forward" },
      ],
    });
    await expect(
      commitSiteVersion(deps({ github: raced.fetch }), client, {
        siteId: "site-1",
        files,
        message: "v2",
      }),
    ).rejects.toThrow(/changed while saving/);
  });

  it("takes parentSha null to mean the repository should still be empty", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const busy = gitRoutes(200);
    await expect(
      commitSiteVersion(deps({ github: busy.fetch }), client, {
        siteId: "site-1",
        files,
        message: "v1",
        parentSha: null,
      }),
    ).rejects.toThrow(/changed since/);
    expect(busy.of("POST", `${repo}/git/trees`)).toHaveLength(0);

    const empty = gitRoutes(409, {
      [`PUT ${repo}/contents/app/page.tsx`]: () => [201, { commit: { sha: "seed-1" } }],
    });
    await commitSiteVersion(deps({ github: empty.fetch }), client, {
      siteId: "site-1",
      files,
      message: "v1",
      parentSha: null,
    });
    expect(empty.of("POST", `${repo}/git/commits`)).toHaveLength(1);
  });

  it("keeps a file marked executable executable", async () => {
    const gh = gitRoutes(200);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await commitSiteVersion(deps({ github: gh.fetch }), client, {
      siteId: "site-1",
      files: [
        { path: "scripts/build.sh", content: "#!/bin/sh\n", executable: true },
        { path: "README.md", content: "hi" },
      ],
      message: "v2",
    });
    const body = gh.of("POST", `${repo}/git/trees`)[0]?.body as { tree: { mode: string }[] };
    expect(body.tree.map((t) => t.mode)).toEqual(["100755", "100644"]);
  });

  it("refuses unsafe paths before calling GitHub", async () => {
    const gh = gitRoutes(200);
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      commitSiteVersion(deps({ github: gh.fetch }), client, {
        siteId: "site-1",
        files: [...files, { path: ".env.local", content: "SECRET=1" }],
        message: "v2",
      }),
    ).rejects.toThrow(/environment files/);
    expect(gh.calls).toHaveLength(0);
  });

  it("needs a repository first", async () => {
    await addSite("site-2");
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      commitSiteVersion(deps(), client, { siteId: "site-2", files, message: "v1" }),
    ).rejects.toThrow(/repository first/);
  });
});

describe("deploying a site on Vercel", () => {
  const vercelRoutes = (extra: Record<string, Route> = {}) =>
    fakeFetch({
      "POST /v11/projects": (call) => [
        200,
        {
          id: "prj_new",
          name: (call.body as { name: string }).name,
          link: { type: "github", productionBranch: "main" },
        },
      ],
      "POST /v13/deployments": () => [200, { id: "dpl_1", readyState: "QUEUED" }],
      "GET /v6/deployments": () => [
        200,
        {
          deployments: [
            {
              // The deployment's own address, behind deployment protection: never the site's.
              url: "acme-dental-k2j4h6g8f-agency.vercel.app",
              readyState: "READY",
              target: "production",
              created: 1,
            },
          ],
        },
      ],
      "GET /v9/projects/prj_new": () => [
        200,
        {
          id: "prj_new",
          name: "acme-dental",
          targets: {
            production: {
              alias: [
                "www.acme.example",
                "acme-dental-agency.vercel.app",
                "acme-dental.vercel.app",
              ],
            },
          },
        },
      ],
      ...extra,
    });

  it("creates a Next.js project linked to the repository, and deploys a pushed site", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/Acme_Dental", status: "pushed" });
    const v = vercelRoutes();
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const row = await ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, {
      siteId: "site-1",
    });
    expect(row).toMatchObject({ host: "vercel", hostProjectId: "prj_new", status: "pushed" });
    const [create] = v.of("POST", "/v11/projects");
    expect(create?.url.searchParams.get("teamId")).toBe(STUB_VERCEL_TEAM.id);
    expect(create?.auth).toBe("Bearer vercel-stub-token");
    expect(create?.body).toEqual({
      name: "acme_dental",
      framework: "nextjs",
      gitRepository: { type: "github", repo: "acme/Acme_Dental" },
    });
    expect(v.of("POST", "/v13/deployments")[0]?.body).toEqual({
      name: "acme_dental",
      project: "prj_new",
      target: "production",
      gitSource: { type: "github", org: "acme", repo: "Acme_Dental", ref: "main" },
    });
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual([
      "site.project.create",
    ]);

    // Once only.
    await ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, {
      siteId: "site-1",
    });
    expect(v.of("POST", "/v11/projects")).toHaveLength(1);

    // The latest deployment, and its address kept once ready.
    expect(await latestDeployment(deps({ vercel: v.fetch }), client, "site-1")).toEqual({
      state: "READY",
      url: "https://acme-dental.vercel.app",
      createdAt: 1,
    });
    expect(v.of("GET", "/v6/deployments")[0]?.url.searchParams.get("projectId")).toBe("prj_new");
    expect(v.of("GET", "/v6/deployments")[0]?.url.searchParams.get("limit")).toBe("1");
    expect(v.of("GET", "/v6/deployments")[0]?.url.searchParams.get("target")).toBe("production");
    expect(await siteRow("site-1")).toMatchObject({
      deployUrl: "https://acme-dental.vercel.app",
      status: "deployed",
    });
  });

  it("shows the production address, not a protected deployment URL, and ignores previews", async () => {
    await addSite("site-1", "client-1", {
      repoFullName: "acme/site",
      host: "vercel",
      hostProjectId: "prj_new",
      status: "deployed",
      deployUrl: "https://acme-dental.vercel.app",
    });
    const client = await authorizeClient(db, ctx("owner"), "client-1");

    // A project without aliases: `<name>.vercel.app`.
    const bare = vercelRoutes({
      "GET /v9/projects/prj_new": () => [200, { id: "prj_new", name: "acme-site" }],
    });
    expect((await latestDeployment(deps({ vercel: bare.fetch }), client, "site-1"))?.url).toBe(
      "https://acme-site.vercel.app",
    );
    expect((await siteRow("site-1"))?.deployUrl).toBe("https://acme-site.vercel.app");

    // A failed preview is not the live site: nothing changes.
    const preview = vercelRoutes({
      "GET /v6/deployments": () => [
        200,
        { deployments: [{ url: "acme-site-git-x.vercel.app", state: "ERROR", target: "preview" }] },
      ],
    });
    expect(await latestDeployment(deps({ vercel: preview.fetch }), client, "site-1")).toBeNull();
    expect(await siteRow("site-1")).toMatchObject({
      status: "deployed",
      deployUrl: "https://acme-site.vercel.app",
    });

    // While a new production build runs, the address already live.
    const building = vercelRoutes({
      "GET /v6/deployments": () => [
        200,
        {
          deployments: [{ url: "acme-site-b.vercel.app", state: "BUILDING", target: "production" }],
        },
      ],
    });
    expect(await latestDeployment(deps({ vercel: building.fetch }), client, "site-1")).toEqual({
      state: "BUILDING",
      url: "https://acme-site.vercel.app",
      createdAt: null,
    });
  });

  it("tries a suffixed project name when the team already has one by that name", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site" });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const v = vercelRoutes({
      "POST /v11/projects": (call) =>
        (call.body as { name: string }).name === "site"
          ? [409, { error: { code: "conflict", message: "Project already exists" } }]
          : [200, { id: "prj_new", name: (call.body as { name: string }).name }],
    });
    const row = await ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, {
      siteId: "site-1",
    });
    expect(row.hostProjectId).toBe("prj_new");
    expect(v.of("POST", "/v11/projects").map((c) => (c.body as { name: string }).name)).toEqual([
      "site",
      "site-site1",
    ]);

    await addSite("site-2", "client-1", { repoFullName: "acme/site" + "-two" });
    const full = vercelRoutes({
      "POST /v11/projects": () => [409, { error: { code: "conflict", message: "exists" } }],
    });
    await expect(
      ensureSiteDeployment(deps({ vercel: full.fetch }), ctx("owner"), client, {
        siteId: "site-2",
      }),
    ).rejects.toThrow(/already has projects named site-two and site-two-site2/);
  });

  it("keeps Vercel's own message for an unrelated refusal", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site" });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const v = vercelRoutes({
      "POST /v11/projects": () => [
        400,
        { error: { code: "bad_request", message: "Invalid request: `framework` is not valid." } },
      ],
    });
    await expect(
      ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, { siteId: "site-1" }),
    ).rejects.toThrow("Vercel: Invalid request: `framework` is not valid.");
  });

  it("doesn't ask for a deployment before anything is committed", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site" });
    const v = vercelRoutes();
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, {
      siteId: "site-1",
    });
    expect(v.of("POST", "/v13/deployments")).toHaveLength(0);
  });

  it("tells the agency to give Vercel's GitHub app access when Vercel can't see the repo", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site" });
    const v = vercelRoutes({
      "POST /v11/projects": () => [
        400,
        {
          error: {
            code: "bad_request",
            message:
              "To link a GitHub repository, you need to install the GitHub integration first.",
          },
        },
      ],
    });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await expect(
      ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, { siteId: "site-1" }),
    ).rejects.toThrow(
      "Vercel can't see acme/site. On GitHub, give Vercel's GitHub app access to that repository (or to all repositories), then try again.",
    );
    expect((await siteRow("site-1"))?.hostProjectId).toBeNull();
  });

  it("marks a failed build, and needs a repository and a project", async () => {
    await addSite("site-1", "client-1", { repoFullName: "acme/site", status: "pushed" });
    await addSite("site-2");
    const v = vercelRoutes({
      "GET /v6/deployments": () => [
        200,
        { deployments: [{ url: null, state: "ERROR", target: "production" }] },
      ],
    });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    expect(await latestDeployment(deps({ vercel: v.fetch }), client, "site-1")).toBeNull();
    await expect(
      ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, { siteId: "site-2" }),
    ).rejects.toThrow(/repository first/);
    await ensureSiteDeployment(deps({ vercel: v.fetch }), ctx("owner"), client, {
      siteId: "site-1",
    });
    expect(await latestDeployment(deps({ vercel: v.fetch }), client, "site-1")).toEqual({
      state: "ERROR",
      url: null,
      createdAt: null,
    });
    expect((await siteRow("site-1"))?.status).toBe("failed");
  });
});

describe("who may publish", () => {
  beforeEach(async () => {
    await addSite("site-1", "client-1", {
      repoFullName: "acme/site",
      hostProjectId: "prj_x",
      host: "vercel",
    });
    await addSite("site-new");
  });

  it("never reaches another client's site", async () => {
    const other = await authorizeClient(db, ctx("owner"), "client-2");
    const d = deps();
    const missing = /isn't one of this client's/;
    await expect(
      ensureSiteRepo(d, ctx("owner"), other, { siteId: "site-new", name: "x" }),
    ).rejects.toThrow(missing);
    await expect(
      commitSiteVersion(d, other, {
        siteId: "site-1",
        files: [{ path: "a.ts", content: "" }],
        message: "x",
      }),
    ).rejects.toThrow(missing);
    await expect(
      ensureSiteDeployment(d, ctx("owner"), other, { siteId: "site-1" }),
    ).rejects.toThrow(missing);
    await expect(latestDeployment(d, other, "site-1")).rejects.toThrow(missing);
  });

  it("lets only owners and admins create repositories and projects", async () => {
    const client = await authorizeClient(db, ctx("staff"), "client-1");
    const d = deps();
    await expect(
      ensureSiteRepo(d, ctx("staff"), client, { siteId: "site-new", name: "x" }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(
      ensureSiteDeployment(d, ctx("staff"), client, { siteId: "site-new" }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(listInstallationRepos(d, ctx("staff"))).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("refuses a client object that skipped the access check", async () => {
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    const forged = { ...client };
    await expect(latestDeployment(deps(), forged, "site-1")).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    await expect(
      commitSiteVersion(deps(), forged, {
        siteId: "site-1",
        files: [{ path: "a.ts", content: "" }],
        message: "x",
      }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
  });
});

describe("the whole flow on the stubs", () => {
  it("creates the repository, commits two versions, deploys and shows the live address", async () => {
    await addSite("site-1");
    const github = createStubGithub();
    const d = deps({ github, vercel: createStubVercel(), appId: STUB_GITHUB_APP_ID });
    const client = await authorizeClient(db, ctx("owner"), "client-1");

    const { repoFullName } = await ensureSiteRepo(d, ctx("owner"), client, {
      siteId: "site-1",
      name: "acme-dental",
    });
    expect(repoFullName).toBe(`${STUB_GITHUB_INSTALLATION.login}/acme-dental`);
    expect(github.repoFiles(repoFullName as string)).toEqual({});

    const first = await commitSiteVersion(d, client, {
      siteId: "site-1",
      message: "First version",
      files: [
        { path: "app/page.tsx", content: "v1" },
        { path: "app/old.tsx", content: "old" },
        { path: "public/x.bin", content: new Uint8Array([1, 2, 255]) },
      ],
    });
    expect(github.repoFiles(repoFullName as string)).toEqual({
      "app/page.tsx": "v1",
      "app/old.tsx": "old",
      "public/x.bin": "\x01\x02\xff",
    });

    await ensureSiteDeployment(d, ctx("owner"), client, { siteId: "site-1" });
    await commitSiteVersion(d, client, {
      siteId: "site-1",
      message: "Second version",
      files: [{ path: "app/page.tsx", content: "v2" }],
      parentSha: first.commitSha,
    });
    // Left out of the snapshot: gone.
    expect(github.repoFiles(repoFullName as string)).toEqual({ "app/page.tsx": "v2" });

    expect(await latestDeployment(d, client, "site-1")).toMatchObject({
      state: "READY",
      url: "https://acme-dental.vercel.app",
    });
    expect(await siteRow("site-1")).toMatchObject({
      host: "vercel",
      status: "deployed",
      deployUrl: "https://acme-dental.vercel.app",
    });
  });

  it("links the stub's existing empty repository", async () => {
    await addSite("site-1");
    const github = createStubGithub();
    const d = deps({ github, appId: STUB_GITHUB_APP_ID });
    const client = await authorizeClient(db, ctx("owner"), "client-1");
    await ensureSiteRepo(d, ctx("owner"), client, {
      siteId: "site-1",
      repoFullName: STUB_GITHUB_EMPTY_REPO,
    });
    await commitSiteVersion(d, client, {
      siteId: "site-1",
      message: "v1",
      files: [{ path: "README.md", content: "hi" }],
    });
    expect(github.repoFiles(STUB_GITHUB_EMPTY_REPO)).toEqual({ "README.md": "hi" });
  });

  it("refuses an app JWT with the wrong issuer", async () => {
    const d = deps({ github: createStubGithub(), appId: "someone-else" });
    await expect(
      installationToken(d, String(STUB_GITHUB_INSTALLATION.id), {
        permissions: { metadata: "read" },
      }),
    ).rejects.toThrow(/GitHub refused/);
  });
});
