import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  creditsFor,
  type SessionContext,
} from "@locus/auth";
import { PublishError } from "@locus/builder";
import {
  createStubGithub,
  ensureSiteRepo,
  InstallationTokenCache,
  type PublishDeps,
  STUB_GITHUB_INSTALLATION,
  type StubGithub,
} from "@locus/connect";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import {
  agencyComp,
  auditLog,
  githubInstallation,
  member,
  memberLocation,
  organization,
  site,
  usageEvent,
  usageLimit,
  user,
} from "@locus/db/control";
import { FakeRuntimeProvider } from "@locus/sandbox";
import { MemorySecretStore } from "@locus/secrets";
import { readBrief, SiteWorkspace } from "@locus/studio";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGithubApp } from "./github-app.ts";
import {
  ACTIVE_SITE_COOKIE,
  activeSiteIdFor,
  CLIENT_KEY,
  cookieValue,
  createClientSite,
  createSiteBuilder,
  openClientDb,
  SITE_ID_KEY,
  type SiteBuilderDeps,
  SiteInputError,
  siteRuntimeKey,
  toMeasurement,
  usageMeter,
} from "./site-builder.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let runtimes: FakeRuntimeProvider;
let github: StubGithub;
let clientA: string;
let clientB: string;
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

function publishDeps(): PublishDeps {
  return {
    db,
    secrets: new MemorySecretStore(),
    githubApp: stubGithubApp(),
    github: { fetch: github, apiBaseUrl: "https://api.github.stub" },
    tokens: new InstallationTokenCache(),
  };
}

function deps(overrides: Partial<SiteBuilderDeps> = {}): SiteBuilderDeps {
  return {
    db,
    openClientDb: (client) => openClientDb(provisioner, client),
    runtimes: () => runtimes,
    images: null,
    publish: publishDeps,
    ...overrides,
  };
}

/** A request context as Mastra hands it to tools: something with `get`. */
const context = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

// biome-ignore lint/suspicious/noExplicitAny: calling a Mastra tool's execute directly
type Tools = Record<string, { execute?: (...args: any[]) => Promise<any> }>;
const call = (tools: unknown, name: string, input: unknown, requestContext: unknown) =>
  // biome-ignore lint/style/noNonNullAssertion: every builder tool has execute
  (tools as Tools)[name]!.execute!(input, { requestContext });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-web-builder-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "tenants"));
  runtimes = new FakeRuntimeProvider();
  github = createStubGithub();
  await db.insert(organization).values({ id: "agency-a", name: "A", slug: "a", createdAt: now });
  await addMember("owner", "owner");
  await addMember("staff", "member");
  const control = { control: db, provisioner };
  clientA = (
    await provisionLocation(control, {
      organizationId: "agency-a",
      ghlLocationId: "ga",
      name: "A1",
    })
  ).id;
  clientB = (
    await provisionLocation(control, {
      organizationId: "agency-a",
      ghlLocationId: "gb",
      name: "B1",
    })
  ).id;
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: clientA });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const authorized = (userId: string, locationId: string) =>
  authorizeClient(db, ctx(userId), locationId);

describe("creating a site", () => {
  it("writes the client's site row and version 1 from the template", async () => {
    const client = await authorized("staff", clientA);
    const { siteId, version } = await createClientSite(deps(), ctx("staff"), client, {
      name: "Bright Smiles",
      kind: "landing-page",
      templateId: "",
    });
    expect(version.number).toBe(1);
    const [row] = await db.select().from(site).where(eq(site.id, siteId));
    expect(row).toMatchObject({ locationId: clientA, status: "draft", repoFullName: null });

    const tenant = await openClientDb(provisioner, client);
    const ws = new SiteWorkspace(tenant, siteId);
    expect((await ws.latestVersion())?.number).toBe(1);
    expect((await ws.listFiles()).map((f) => f.path)).toContain("app/page.tsx");
    expect(await readBrief(tenant, siteId)).toMatchObject({
      name: "Bright Smiles",
      kind: "landing-page",
      templateId: "landing-page",
    });
    tenant.$client.close();

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "site.create"));
    expect(audits).toMatchObject([{ locationId: clientA, actorUserId: "staff" }]);
  });

  it("refuses an unknown kind or template and leaves no row behind", async () => {
    const client = await authorized("owner", clientA);
    await expect(
      createClientSite(deps(), ctx("owner"), client, { name: "X", kind: "castle" }),
    ).rejects.toBeInstanceOf(SiteInputError);
    await expect(
      createClientSite(deps(), ctx("owner"), client, {
        name: "X",
        kind: "website",
        templateId: "nope",
      }),
    ).rejects.toBeInstanceOf(SiteInputError);
    await expect(
      createClientSite(deps(), ctx("owner"), client, { name: " ", kind: "website" }),
    ).rejects.toBeInstanceOf(SiteInputError);
    expect(await db.select().from(site)).toEqual([]);
  });

  it("only takes a client that passed the staff check", async () => {
    await expect(authorized("staff", clientB)).rejects.toBeInstanceOf(ClientAccessDenied);
    const forged = { location: { id: clientB }, memberId: "staff@agency-a" } as AuthorizedClient;
    await expect(
      createClientSite(deps(), ctx("staff"), forged, { name: "X", kind: "website" }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    expect(await db.select().from(site)).toEqual([]);
  });
});

describe("resolving the builder session", () => {
  it("opens the client's own site: its workspace, sandbox and author", async () => {
    const client = await authorized("owner", clientA);
    const { siteId } = await createClientSite(deps(), ctx("owner"), client, {
      name: "A site",
      kind: "website",
    });
    const builder = createSiteBuilder(deps(), { client, userId: "owner" });
    expect(builder.modes[0].id).toBeTruthy();
    expect(builder.processors.output).toHaveLength(1);

    const session = await builder.resolve(context({ [SITE_ID_KEY]: siteId }));
    expect(session.workspace.siteId).toBe(siteId);
    expect(session.userId).toBe("owner");
    await session.runtime();
    expect(siteRuntimeKey(client, siteId)).toBe(`${clientA}/${siteId}`);
    expect([...runtimes.runtimes.keys()]).toEqual([`${clientA}/${siteId}`]);

    const listed = await call(builder.tools, "list_files", {}, context({ [SITE_ID_KEY]: siteId }));
    expect(listed.files.map((f: { path: string }) => f.path)).toContain("app/page.tsx");
  });

  it("refuses another client's site and a missing one before opening anything", async () => {
    const owner = await authorized("owner", clientA);
    const other = await authorized("owner", clientB);
    const { siteId: otherSite } = await createClientSite(deps(), ctx("owner"), other, {
      name: "B site",
      kind: "website",
    });
    const opened: string[] = [];
    const builder = createSiteBuilder(
      deps({
        openClientDb: (client) => {
          opened.push(client.location.id);
          return openClientDb(provisioner, client);
        },
      }),
      { client: owner },
    );
    await expect(builder.resolve(context({ [SITE_ID_KEY]: otherSite }))).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    await expect(
      builder.resolve(context({ [SITE_ID_KEY]: "no-such-site" })),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(builder.resolve(context({}))).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(builder.resolve(undefined)).rejects.toBeInstanceOf(ClientAccessDenied);
    expect(opened).toEqual([]);
    expect(runtimes.runtimes.size).toBe(0);
  });

  it("refuses a request-context client for another client or one not authorized", async () => {
    const owner = await authorized("owner", clientA);
    const { siteId } = await createClientSite(deps(), ctx("owner"), owner, {
      name: "A",
      kind: "website",
    });
    const builder = createSiteBuilder(deps(), { client: owner });
    const otherClient = await authorized("owner", clientB);
    await expect(
      builder.resolve(context({ [SITE_ID_KEY]: siteId, [CLIENT_KEY]: otherClient })),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    const forged = { location: owner.location, memberId: "x" } as AuthorizedClient;
    await expect(
      builder.resolve(context({ [SITE_ID_KEY]: siteId, [CLIENT_KEY]: forged })),
    ).rejects.toBeInstanceOf(ClientAccessDenied);

    const staff = await authorized("staff", clientA);
    const session = await builder.resolve(context({ [SITE_ID_KEY]: siteId, [CLIENT_KEY]: staff }));
    expect(session.workspace.siteId).toBe(siteId);
  });
});

describe("the usage meter", () => {
  it("maps builder usage to measurements and records it against the client and site", async () => {
    expect(toMeasurement({ kind: "image", count: 2, size: "large", model: "gpt-image-1" })).toEqual(
      { kind: "image", count: 2, size: "large" },
    );
    expect(toMeasurement({ kind: "sandbox", seconds: 30 })).toEqual({
      kind: "sandbox",
      seconds: 30,
    });

    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    const client = await authorized("staff", clientA);
    const meter = usageMeter(db, client, { siteId: "site-x", userId: "staff" });
    expect(await meter.check()).toEqual({ ok: true });
    await meter.record({ kind: "image", count: 2, size: "large", model: "gpt-image-1" });
    await meter.record({ kind: "sandbox", seconds: 30 });

    const events = await db.select().from(usageEvent);
    expect(events.map((e) => [e.kind, e.locationId, e.siteId, e.actorUserId, e.credits])).toEqual([
      ["image", clientA, "site-x", "staff", creditsFor({ kind: "image", count: 2, size: "large" })],
      ["sandbox", clientA, "site-x", "staff", creditsFor({ kind: "sandbox", seconds: 30 })],
    ]);
  });

  it("refuses with checkAllowance's reason", async () => {
    const client = await authorized("owner", clientA);
    // No plan and no comp: not entitled.
    expect(await usageMeter(db, client).check()).toEqual({
      ok: false,
      reason: expect.stringMatching(/Choose a Locus plan/),
    });
    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    await db.insert(usageLimit).values({ locationId: clientA, paused: true, updatedAt: now });
    expect(await usageMeter(db, client).check()).toEqual({
      ok: false,
      reason: expect.stringMatching(/paused/),
    });
  });

  it("stops sandbox tools when the client has no credits", async () => {
    const client = await authorized("owner", clientA);
    const { siteId } = await createClientSite(deps(), ctx("owner"), client, {
      name: "A",
      kind: "website",
    });
    const builder = createSiteBuilder(deps(), { client });
    const result = await call(builder.tools, "check_site", {}, context({ [SITE_ID_KEY]: siteId }));
    expect(result).toEqual({ error: expect.stringMatching(/Choose a Locus plan/) });
    expect(runtimes.runtimes.size).toBe(0);
  });
});

describe("publishing saved versions", () => {
  beforeEach(async () => {
    await db.insert(githubInstallation).values({
      organizationId: "agency-a",
      installationId: String(STUB_GITHUB_INSTALLATION.id),
      orgLogin: STUB_GITHUB_INSTALLATION.login,
      connectedAt: now,
    });
  });

  async function startedSite() {
    const client = await authorized("owner", clientA);
    const { siteId } = await createClientSite(deps(), ctx("owner"), client, {
      name: "A",
      kind: "website",
      templateId: "blank",
    });
    return { client, siteId };
  }

  it("commits the version's files to the site's repository through the stub GitHub", async () => {
    const { client, siteId } = await startedSite();
    const { repoFullName } = await ensureSiteRepo(publishDeps(), ctx("owner"), client, {
      siteId,
      name: "a-site",
    });
    const builder = createSiteBuilder(deps(), { client, userId: "owner" });
    const rc = context({ [SITE_ID_KEY]: siteId });
    await call(builder.tools, "write_file", { path: "app/about/page.tsx", content: "about" }, rc);
    const saved = await call(builder.tools, "save_version", { message: "Add about" }, rc);
    expect(saved).toMatchObject({ saved: true, version: 2, commitUrl: expect.any(String) });
    expect(saved.publishError).toBeUndefined();

    const session = await builder.resolve(rc);
    const snapshot = await session.workspace.snapshot();
    const expected = Object.fromEntries(
      snapshot.map((f) => [f.path, typeof f.content === "string" ? f.content : ""]),
    );
    expect(github.repoFiles(repoFullName as string)).toEqual(expected);
    expect(github.repoFiles(repoFullName as string)?.["app/about/page.tsx"]).toBe("about");
    const latest = await session.workspace.latestVersion();
    expect(latest?.commitSha).toMatch(/\w+/);
    const [row] = await db.select().from(site).where(eq(site.id, siteId));
    expect(row?.status).toBe("pushed");
  });

  it("leaves a site without a repository unpublished, with no call to GitHub", async () => {
    const { client, siteId } = await startedSite();
    let built = 0;
    const builder = createSiteBuilder(
      deps({
        publish: () => {
          built++;
          return publishDeps();
        },
      }),
      { client },
    );
    const session = await builder.resolve(context({ [SITE_ID_KEY]: siteId }));
    const version = await session.workspace.latestVersion();
    expect(
      await session.onVersionSaved?.(
        version as NonNullable<typeof version>,
        await session.workspace.snapshot(),
      ),
    ).toBeUndefined();
    expect(built).toBe(0);
  });

  it("turns a refusal written for the person into a PublishError", async () => {
    const { client, siteId } = await startedSite();
    await ensureSiteRepo(publishDeps(), ctx("owner"), client, { siteId, name: "a-site" });
    await db.delete(githubInstallation);
    const builder = createSiteBuilder(deps(), { client });
    const session = await builder.resolve(context({ [SITE_ID_KEY]: siteId }));
    const version = await session.workspace.latestVersion();
    const saving = session.onVersionSaved?.(
      version as NonNullable<typeof version>,
      await session.workspace.snapshot(),
    );
    await expect(saving).rejects.toBeInstanceOf(PublishError);
    await expect(saving).rejects.toThrow(/Connect GitHub/);
  });
});

describe("the active site for the chat API", () => {
  const request = (cookie?: string) => ({
    headers: new Headers(cookie ? { cookie } : {}),
  });

  it("returns the chosen site only when it is the member's client's", async () => {
    const a = await authorized("owner", clientA);
    const b = await authorized("owner", clientB);
    const { siteId: siteA } = await createClientSite(deps(), ctx("owner"), a, {
      name: "A",
      kind: "website",
    });
    const { siteId: siteB } = await createClientSite(deps(), ctx("owner"), b, {
      name: "B",
      kind: "website",
    });
    const chose = (id: string) => request(`other=1; ${ACTIVE_SITE_COOKIE}=${id}`);
    expect(await activeSiteIdFor(db, chose(siteA), clientA)).toBe(siteA);
    expect(await activeSiteIdFor(db, chose(siteB), clientA)).toBeNull();
    expect(await activeSiteIdFor(db, chose("missing"), clientA)).toBeNull();
    expect(await activeSiteIdFor(db, request(), clientA)).toBeNull();
    expect(await activeSiteIdFor(db, chose(siteA), "")).toBeNull();
  });

  it("reads one cookie from a header", () => {
    expect(cookieValue("a=1; locus_site=x%2Fy", "locus_site")).toBe("x/y");
    expect(cookieValue("locus_site_other=1", "locus_site")).toBeNull();
    expect(cookieValue(null, "locus_site")).toBeNull();
    expect(cookieValue("locus_site=%E0%A4%A", "locus_site")).toBeNull();
  });
});
