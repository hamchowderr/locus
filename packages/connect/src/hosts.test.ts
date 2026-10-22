import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientAccessDenied, type SessionContext } from "@locus/auth";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { githubInstallation, hostConnection, member, organization, user } from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectError } from "./agency.ts";
import {
  connectGithub,
  type GithubConnectDeps,
  githubInstallUrl,
  handleGithubWebhook,
  verifyGithubSignature,
} from "./github.ts";
import {
  createStubGithub,
  createStubVercel,
  STUB_GITHUB_CODE,
  STUB_GITHUB_INSTALLATION,
  STUB_VERCEL_CODE,
  STUB_VERCEL_CONFIGURATION,
  STUB_VERCEL_TEAM,
} from "./stub-hosts.ts";
import {
  connectVercel,
  type VercelConnectDeps,
  vercelInstallUrl,
  vercelSecretRef,
} from "./vercel.ts";
import { handleVercelWebhook, verifyVercelSignature } from "./vercel-webhook.ts";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
const now = new Date();

const ctx = (userId: string, activeOrganizationId: string): SessionContext => ({
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-hosts-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const github = { slug: "locus-ghl", clientId: "Iv23-test", clientSecret: "gh-secret" };
const githubDeps = (fetch = createStubGithub()): GithubConnectDeps => ({
  db,
  github,
  http: { fetch, webBaseUrl: "https://github.test", apiBaseUrl: "https://api.github.test" },
});

describe("connecting GitHub", () => {
  it("sends the agency to the app's install page with a state", () => {
    const url = new URL(githubInstallUrl(github, "state-1"));
    expect(url.href).toBe("https://github.com/apps/locus-ghl/installations/new?state=state-1");
  });

  it("links the installation the installing user can access, and keeps no token", async () => {
    const result = await connectGithub(githubDeps(), ctx("owner", "agency-a"), {
      code: STUB_GITHUB_CODE,
      installationId: String(STUB_GITHUB_INSTALLATION.id),
    });
    expect(result).toEqual({
      installationId: String(STUB_GITHUB_INSTALLATION.id),
      accountLogin: STUB_GITHUB_INSTALLATION.login,
    });
    const rows = await db.select().from(githubInstallation);
    expect(rows).toMatchObject([
      { organizationId: "agency-a", installationId: "424242", orgLogin: "stub-agency-org" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("ghu_");
  });

  it("refuses a forged installation id the user cannot access", async () => {
    await expect(
      connectGithub(githubDeps(), ctx("owner", "agency-a"), {
        code: STUB_GITHUB_CODE,
        installationId: "999",
      }),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(await db.select().from(githubInstallation)).toEqual([]);
  });

  it("uses the only installation when GitHub sends no id, and refuses a bad code", async () => {
    await connectGithub(githubDeps(), ctx("owner", "agency-a"), { code: STUB_GITHUB_CODE });
    expect(await db.select().from(githubInstallation)).toHaveLength(1);
    await expect(
      connectGithub(githubDeps(), ctx("owner", "agency-a"), { code: "wrong" }),
    ).rejects.toThrow(/didn't accept/);
  });

  it("only lets owners and admins connect", async () => {
    await expect(
      connectGithub(githubDeps(), ctx("staff", "agency-a"), { code: STUB_GITHUB_CODE }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(
      connectGithub(githubDeps(), ctx("owner", "agency-b"), { code: STUB_GITHUB_CODE }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("checks webhook signatures against GitHub's published example", () => {
    const secret = "It's a Secret to Everybody";
    const body = "Hello, World!";
    const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(verifyGithubSignature(body, good, secret)).toBe(true);
    expect(verifyGithubSignature(`${body} `, good, secret)).toBe(false);
    expect(verifyGithubSignature(body, good, "other")).toBe(false);
    expect(verifyGithubSignature(body, good.replace("sha256=", "sha1="), secret)).toBe(false);
    expect(verifyGithubSignature(body, null, secret)).toBe(false);
    expect(verifyGithubSignature(body, good, "")).toBe(false);
  });

  it("unlinks every agency when the app is uninstalled", async () => {
    await connectGithub(githubDeps(), ctx("owner", "agency-a"), { code: STUB_GITHUB_CODE });
    const deps = { db };
    expect(
      await handleGithubWebhook(deps, "installation", {
        action: "suspend",
        installation: { id: 424242 },
      }),
    ).toBe("ignored");
    expect(await db.select().from(githubInstallation)).toHaveLength(1);
    expect(
      await handleGithubWebhook(deps, "installation", {
        action: "deleted",
        installation: { id: 424242 },
      }),
    ).toBe("unlinked");
    expect(await db.select().from(githubInstallation)).toEqual([]);
  });
});

const vercel = {
  slug: "locus-otaku",
  clientId: "oac_test",
  clientSecret: "vercel-secret",
  redirectUri: "https://locus.test/api/connect/vercel/callback",
};
const vercelDeps = (fetch = createStubVercel()): VercelConnectDeps => ({
  db,
  secrets,
  vercel,
  http: { fetch, apiBaseUrl: "https://api.vercel.test" },
});

describe("connecting Vercel", () => {
  it("sends the agency to the integration's install page with a state", () => {
    expect(vercelInstallUrl(vercel, "state-2")).toBe(
      "https://vercel.com/integrations/locus-otaku/new?state=state-2",
    );
  });

  it("exchanges the code as a form, seals the token and keeps only the team in the row", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const stub = createStubVercel();
    const recording = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string | undefined });
      return stub(input, init);
    }) as typeof fetch;

    const result = await connectVercel(vercelDeps(recording), ctx("owner", "agency-a"), {
      code: STUB_VERCEL_CODE,
    });
    expect(result).toEqual({ teamId: STUB_VERCEL_TEAM.id, accountName: STUB_VERCEL_TEAM.name });

    const exchange = new URLSearchParams(calls[0]?.body);
    expect(calls[0]?.url).toBe("https://api.vercel.test/v2/oauth/access_token");
    expect(Object.fromEntries(exchange)).toEqual({
      client_id: "oac_test",
      client_secret: "vercel-secret",
      code: STUB_VERCEL_CODE,
      redirect_uri: vercel.redirectUri,
    });
    expect(calls[1]?.url).toBe("https://api.vercel.test/v2/teams/team_stub?teamId=team_stub");

    const [row] = await db.select().from(hostConnection);
    expect(row).toMatchObject({
      organizationId: "agency-a",
      provider: "vercel",
      teamId: STUB_VERCEL_TEAM.id,
      accountName: STUB_VERCEL_TEAM.name,
      secretRef: vercelSecretRef("agency-a"),
    });
    expect(JSON.stringify(row)).not.toContain("vercel-stub-token");
    expect(JSON.parse((await secrets.get(vercelSecretRef("agency-a"))) as string)).toMatchObject({
      accessToken: "vercel-stub-token",
      teamId: STUB_VERCEL_TEAM.id,
      configurationId: "icfg_stub",
    });
  });

  it("refuses a bad code and writes nothing", async () => {
    await expect(
      connectVercel(vercelDeps(), ctx("owner", "agency-a"), { code: "wrong" }),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(await db.select().from(hostConnection)).toEqual([]);
    expect(await secrets.get(vercelSecretRef("agency-a"))).toBeUndefined();
  });

  it("only lets owners and admins connect", async () => {
    await expect(
      connectVercel(vercelDeps(), ctx("staff", "agency-a"), { code: STUB_VERCEL_CODE }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
  });
});

describe("the Vercel integration removed on Vercel's side", () => {
  const removed = (configurationId: string, teamId: string | null = STUB_VERCEL_TEAM.id) => ({
    type: "integration-configuration.removed",
    payload: {
      configuration: { id: configurationId },
      team: teamId ? { id: teamId } : null,
      user: { id: "user_stub" },
    },
  });

  it("checks Vercel's signature on the exact body", () => {
    const body = JSON.stringify(removed(STUB_VERCEL_CONFIGURATION));
    const signature = createHmac("sha1", "vercel-secret").update(body).digest("hex");
    expect(verifyVercelSignature(body, signature, "vercel-secret")).toBe(true);
    expect(verifyVercelSignature(`${body} `, signature, "vercel-secret")).toBe(false);
    expect(verifyVercelSignature(body, signature, "other-secret")).toBe(false);
    expect(verifyVercelSignature(body, null, "vercel-secret")).toBe(false);
    expect(verifyVercelSignature(body, "short", "vercel-secret")).toBe(false);
  });

  it("disconnects the agency that installed it and drops its token", async () => {
    await connectVercel(vercelDeps(), ctx("owner", "agency-a"), { code: STUB_VERCEL_CODE });

    expect(await handleVercelWebhook({ db, secrets }, removed(STUB_VERCEL_CONFIGURATION))).toBe(
      "disconnected",
    );
    expect(await db.select().from(hostConnection)).toEqual([]);
    expect(await secrets.get(vercelSecretRef("agency-a"))).toBeUndefined();
    // Delivered again: nothing left to do.
    expect(await handleVercelWebhook({ db, secrets }, removed(STUB_VERCEL_CONFIGURATION))).toBe(
      "ignored",
    );
  });

  it("keeps a connection made since by another installation, and other teams' alone", async () => {
    await connectVercel(vercelDeps(), ctx("owner", "agency-a"), { code: STUB_VERCEL_CODE });

    for (const event of [
      removed("icfg_older"),
      removed(STUB_VERCEL_CONFIGURATION, "team_other"),
      { type: "project.created", payload: { configuration: { id: STUB_VERCEL_CONFIGURATION } } },
      { type: "integration-configuration.removed", payload: {} },
    ]) {
      expect(await handleVercelWebhook({ db, secrets }, event)).toBe("ignored");
    }
    expect(await db.select().from(hostConnection)).toHaveLength(1);
    expect(await secrets.get(vercelSecretRef("agency-a"))).toBeDefined();
  });
});
