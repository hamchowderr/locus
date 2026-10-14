import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import {
  ConnectError,
  createStubGithub,
  createStubVercel,
  InstallationTokenCache,
  latestDeployment,
  listInstallationRepos,
  type PublishDeps,
  STUB_GITHUB_EMPTY_REPO,
  STUB_GITHUB_INSTALLATION,
  STUB_VERCEL_TEAM,
  type StubGithub,
  vercelSecretRef,
} from "@locus/connect";
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
import { stubGithubApp } from "./github-app.ts";
import {
  deploymentLabel,
  giveSiteProject,
  giveSiteRepo,
  linkableRepos,
  repoInput,
  suggestedRepoName,
} from "./site-publish.ts";

// The Sites page's publishing steps, on a temp control database with the stub GitHub
// (`GITHUB_MODE=stub`) and the stub Vercel team. No network.

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let github: StubGithub;
let vercel: typeof fetch;
const now = new Date();

const ctx = (userId: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId: "agency-a",
});

async function addMember(userId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true });
  await db.insert(member).values({
    id: `${userId}@agency-a`,
    userId,
    organizationId: "agency-a",
    role,
    createdAt: now,
  });
}

async function addClient(id: string) {
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

function deps(): PublishDeps {
  return {
    db,
    secrets,
    githubApp: stubGithubApp(),
    github: { fetch: github, apiBaseUrl: "https://api.github.stub" },
    http: { fetch: vercel, apiBaseUrl: "https://api.vercel.stub" },
    tokens: new InstallationTokenCache(),
  };
}

const siteRow = async (id: string) => (await db.select().from(site).where(eq(site.id, id)))[0];
const authorized = (userId: string, locationId: string) =>
  authorizeClient(db, ctx(userId), locationId);
const choice = (siteId: string, picked: { repo?: string; name?: string }) => ({
  siteId,
  repo: picked.repo ?? "",
  name: picked.name ?? "",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-web-publish-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  github = createStubGithub();
  vercel = createStubVercel();
  await db.insert(organization).values({ id: "agency-a", name: "A", slug: "a", createdAt: now });
  await addMember("owner", "owner");
  await addMember("admin", "admin");
  await addMember("staff", "member");
  await addClient("client-1");
  await addClient("client-2");
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "client-1" });
  await db.insert(site).values({ id: "site-1", locationId: "client-1" });
  await db.insert(site).values({ id: "site-2", locationId: "client-2" });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

async function connectGithub() {
  await db.insert(githubInstallation).values({
    organizationId: "agency-a",
    installationId: String(STUB_GITHUB_INSTALLATION.id),
    orgLogin: STUB_GITHUB_INSTALLATION.login,
    connectedAt: now,
  });
}

async function connectVercel() {
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
}

describe("giving a site its repository", () => {
  beforeEach(connectGithub);

  it("lets an owner create a new private repository in the agency's organization", async () => {
    const client = await authorized("owner", "client-1");
    const row = await giveSiteRepo(
      deps(),
      ctx("owner"),
      client,
      choice("site-1", { name: "bright-smiles" }),
    );
    expect(row.repoFullName).toBe(`${STUB_GITHUB_INSTALLATION.login}/bright-smiles`);
    expect((await siteRow("site-1"))?.repoFullName).toBe(row.repoFullName);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "site.repo.create"));
    expect(audits).toMatchObject([{ locationId: "client-1", actorUserId: "owner" }]);
  });

  it("lets an admin link an existing empty repository the Locus app can see", async () => {
    const client = await authorized("admin", "client-1");
    const row = await giveSiteRepo(
      deps(),
      ctx("admin"),
      client,
      choice("site-1", { repo: STUB_GITHUB_EMPTY_REPO, name: "ignored-when-linking" }),
    );
    expect(row.repoFullName).toBe(STUB_GITHUB_EMPTY_REPO);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "site.repo.link"));
    expect(audits).toHaveLength(1);
  });

  it("refuses a member who isn't an owner or admin, even on a client they may work on", async () => {
    const client = await authorized("staff", "client-1");
    await expect(
      giveSiteRepo(deps(), ctx("staff"), client, choice("site-1", { name: "staff-repo" })),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    expect((await siteRow("site-1"))?.repoFullName).toBeNull();
    expect(github.repoFiles(`${STUB_GITHUB_INSTALLATION.login}/staff-repo`)).toBeNull();
  });

  it("refuses a site that belongs to another client", async () => {
    const client = await authorized("owner", "client-1");
    await expect(
      giveSiteRepo(deps(), ctx("owner"), client, choice("site-2", { name: "other-client" })),
    ).rejects.toThrow(/isn't one of this client's/);
    expect((await siteRow("site-2"))?.repoFullName).toBeNull();
    // A restricted member can't reach the other client in the first place.
    await expect(authorized("staff", "client-2")).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("refuses a repository another site already has", async () => {
    await db.insert(site).values({ id: "site-3", locationId: "client-1" });
    const client = await authorized("owner", "client-1");
    await giveSiteRepo(
      deps(),
      ctx("owner"),
      client,
      choice("site-1", { repo: STUB_GITHUB_EMPTY_REPO }),
    );
    await expect(
      giveSiteRepo(
        deps(),
        ctx("owner"),
        client,
        choice("site-3", { repo: STUB_GITHUB_EMPTY_REPO }),
      ),
    ).rejects.toThrow(/already another site's/);
  });

  it("asks for a name when neither a new name nor a repository is given", async () => {
    const client = await authorized("owner", "client-1");
    await expect(
      giveSiteRepo(deps(), ctx("owner"), client, choice("site-1", { name: "  " })),
    ).rejects.toBeInstanceOf(ConnectError);
    expect((await siteRow("site-1"))?.repoFullName).toBeNull();
  });
});

describe("giving a site its Vercel project", () => {
  beforeEach(async () => {
    await connectGithub();
    await connectVercel();
  });

  it("creates a project that builds the repository and shows the latest deployment", async () => {
    const client = await authorized("owner", "client-1");
    await giveSiteRepo(deps(), ctx("owner"), client, choice("site-1", { name: "bright-smiles" }));
    const row = await giveSiteProject(deps(), ctx("owner"), client, "site-1");
    expect(row).toMatchObject({ host: "vercel", hostProjectId: expect.stringMatching(/^prj_/) });
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "site.project.create"));
    expect(audits).toMatchObject([{ locationId: "client-1", actorUserId: "owner" }]);

    // Anyone who may work on the client sees the deployment.
    const staff = await authorized("staff", "client-1");
    const deployment = await latestDeployment(deps(), staff, "site-1");
    expect(deployment).toMatchObject({ state: "READY", url: "https://bright-smiles.vercel.app" });
    expect(deploymentLabel(deployment?.state ?? "")).toBe("Live");
    expect(await siteRow("site-1")).toMatchObject({
      status: "deployed",
      deployUrl: "https://bright-smiles.vercel.app",
    });
  });

  it("needs a repository first, and refuses a member who isn't an owner or admin", async () => {
    const owner = await authorized("owner", "client-1");
    await expect(giveSiteProject(deps(), ctx("owner"), owner, "site-1")).rejects.toThrow(
      /GitHub repository first/,
    );
    await giveSiteRepo(deps(), ctx("owner"), owner, choice("site-1", { name: "bright-smiles" }));
    const staff = await authorized("staff", "client-1");
    await expect(giveSiteProject(deps(), ctx("staff"), staff, "site-1")).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    expect((await siteRow("site-1"))?.hostProjectId).toBeNull();
  });

  it("refuses another client's site", async () => {
    await db
      .update(site)
      .set({ repoFullName: STUB_GITHUB_EMPTY_REPO })
      .where(eq(site.id, "site-2"));
    const client = await authorized("owner", "client-1");
    await expect(giveSiteProject(deps(), ctx("owner"), client, "site-2")).rejects.toThrow(
      /isn't one of this client's/,
    );
    expect((await siteRow("site-2"))?.hostProjectId).toBeNull();
  });
});

describe("an agency without the connections", () => {
  it("says to connect GitHub first, for the list and for giving a repository", async () => {
    const client = await authorized("owner", "client-1");
    await expect(listInstallationRepos(deps(), ctx("owner"))).rejects.toThrow(
      "Connect GitHub on the Connections page first.",
    );
    const giving = giveSiteRepo(deps(), ctx("owner"), client, choice("site-1", { name: "a" }));
    await expect(giving).rejects.toBeInstanceOf(ConnectError);
    await expect(giving).rejects.toThrow("Connect GitHub on the Connections page first.");
  });

  it("says to connect Vercel first before creating a project", async () => {
    await connectGithub();
    const client = await authorized("owner", "client-1");
    await giveSiteRepo(deps(), ctx("owner"), client, choice("site-1", { name: "bright-smiles" }));
    const giving = giveSiteProject(deps(), ctx("owner"), client, "site-1");
    await expect(giving).rejects.toBeInstanceOf(ConnectError);
    await expect(giving).rejects.toThrow("Connect your Vercel team on the Connections page first.");
    expect((await siteRow("site-1"))?.hostProjectId).toBeNull();
  });
});

describe("the repository form's helpers", () => {
  it("links a picked repository, otherwise creates one with the given name", () => {
    expect(repoInput({ siteId: "s", repo: " org/site ", name: "x" })).toEqual({
      siteId: "s",
      repoFullName: "org/site",
    });
    expect(repoInput({ siteId: "s", repo: "", name: " new-site " })).toEqual({
      siteId: "s",
      name: "new-site",
    });
    expect(() => repoInput({ siteId: "s", repo: "", name: "" })).toThrow(ConnectError);
  });

  it("suggests a repository name from the site's name", () => {
    expect(suggestedRepoName("Bright Smiles Dental!")).toBe("bright-smiles-dental");
    expect(suggestedRepoName("  ")).toBe("site");
    expect(suggestedRepoName(undefined)).toBe("site");
    expect(suggestedRepoName("a".repeat(150))).toHaveLength(100);
  });

  it("leaves out repositories this client's sites already have", () => {
    const repos = [
      { fullName: "org/one", private: true },
      { fullName: "org/two", private: true },
    ];
    expect(linkableRepos(repos, [{ repoFullName: "ORG/one" }, { repoFullName: null }])).toEqual([
      { fullName: "org/two", private: true },
    ]);
  });
});
