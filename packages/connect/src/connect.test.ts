import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  listAccessibleClients,
  type SessionContext,
} from "@locus/auth";
import {
  type ControlDb,
  DbSecretStore,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
} from "@locus/db";
import { agencyGhlConnection, location, member, organization, user } from "@locus/db/control";
import { GhlError } from "@locus/ghl";
import { generateSecretsKey, MemorySecretStore, SecretCipher } from "@locus/secrets";
import { createFakeGhl } from "@locus/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agencyToken,
  type ConnectDeps,
  ConnectError,
  checkClientGhl,
  clientGhl,
  clientGhlSession,
  connectAgency,
  ghlSecretRef,
  syncLocations,
} from "./agency.ts";
import { authorizeUrl, exchangeCode, type GhlAppConfig } from "./ghl-oauth.ts";
import { CrmMediaError, siteCrm } from "./site-crm.ts";
import { importStaffAccess, listAgencyStaff } from "./staff.ts";
import { createStubGhl, STUB_AGENCY, STUB_CODE, type StubAgency } from "./stub.ts";
import { handleGhlWebhook, verifyGhlSignature } from "./webhook.ts";

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["locations.readonly", "oauth.readonly", "oauth.write"],
};

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let agency: StubAgency;
let clock: number;
let deps: ConnectDeps;
const now = new Date();

async function addAgency(id: string) {
  await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
}
async function addMember(userId: string, organizationId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true })
    .onConflictDoNothing();
  await db
    .insert(member)
    .values({ id: `${userId}@${organizationId}`, userId, organizationId, role, createdAt: now });
}
const ctx = (userId: string, activeOrganizationId: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId,
});
const registry = (organizationId: string) =>
  db.select().from(location).where(eq(location.organizationId, organizationId));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-connect-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  agency = structuredClone(STUB_AGENCY);
  clock = Date.parse("2026-10-10T12:00:00Z");
  deps = {
    db,
    secrets,
    provisioner: new LocalProvisioner(join(dir, "tenants")),
    ghl,
    http: { fetch: createStubGhl(agency), baseUrl: "https://stub.ghl.test" },
    migrations: [],
    now: () => clock,
  };
  await addAgency("agency-a");
  await addAgency("agency-b");
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
  await addMember("other", "agency-b", "owner");
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("connecting GoHighLevel", () => {
  it("sends the agency to GHL's neutral host with the app's scopes and a state", () => {
    const url = new URL(authorizeUrl(ghl, "state-123"));
    expect(url.origin).toBe("https://marketplace.leadconnectorhq.com");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toBe("locations.readonly oauth.readonly oauth.write");
    expect(url.searchParams.get("redirect_uri")).toBe(ghl.redirectUri);
  });

  it("registers every installed sub-account, across pages, with a database each", async () => {
    const result = await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    expect(result).toMatchObject({ companyId: "stub-company-1", added: 3, unchanged: 0 });
    const rows = await registry("agency-a");
    expect(rows.map((r) => r.name).sort()).toEqual([
      "Harbor Realty",
      "Peak Fitness",
      "Sunrise Dental",
    ]);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("keeps the tokens in the secret store and only a reference in the database", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    const [connection] = await db.select().from(agencyGhlConnection);
    expect(connection?.secretRef).toBe(ghlSecretRef("agency-a"));
    expect(await secrets.get(ghlSecretRef("agency-a"))).toContain("stub-agency-token-");

    // No column in any control table holds a token value.
    const tables = await db.$client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    );
    for (const { name } of tables.rows) {
      const rows = await db.$client.execute(`select * from "${name}"`);
      expect(JSON.stringify(rows.rows)).not.toMatch(/stub-(agency|refresh)-token/);
    }
  });

  it("with the production store, every table holds the tokens only sealed", async () => {
    const cipher = SecretCipher.fromEnv({ LOCUS_SECRETS_KEY: generateSecretsKey() });
    const sealedDeps = { ...deps, secrets: new DbSecretStore(db, cipher) };
    await connectAgency(sealedDeps, ctx("owner", "agency-a"), STUB_CODE);
    expect((await agencyToken(sealedDeps, "agency-a")).token).toContain("stub-agency-token-");

    const tables = await db.$client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    );
    expect(tables.rows.map((r) => r.name)).toContain("secret");
    for (const { name } of tables.rows) {
      const rows = await db.$client.execute(`select * from "${name}"`);
      expect(JSON.stringify(rows.rows)).not.toMatch(/stub-(agency|refresh)-token/);
    }
  });

  it("reconnecting adds nothing twice", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    const again = await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    expect(again).toMatchObject({ added: 0, unchanged: 3 });
    expect(await registry("agency-a")).toHaveLength(3);
  });

  it("finishes a sub-account an earlier run left half set up", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    const [stuck] = await registry("agency-a");
    if (!stuck) throw new Error("no client registered");
    await db.update(location).set({ status: "provisioning" }).where(eq(location.id, stuck.id));

    const again = await syncLocations(deps, "agency-a");
    expect(again).toMatchObject({ added: 1, unchanged: 2 });
    const rows = await registry("agency-a");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("stops at the plan's client limit and says why", async () => {
    const capped: ConnectDeps = {
      ...deps,
      newClientRefusal: async (_org, active) => (active >= 2 ? "Plan covers 2 clients." : null),
    };
    const result = await connectAgency(capped, ctx("owner", "agency-a"), STUB_CODE);
    expect(result).toMatchObject({
      added: 2,
      refused: { count: 1, reason: "Plan covers 2 clients." },
    });
    expect(await registry("agency-a")).toHaveLength(2);

    // Active clients still count as unchanged; the refused one waits for a bigger plan.
    const again = await syncLocations(capped, "agency-a");
    expect(again).toMatchObject({ added: 0, unchanged: 2, refused: { count: 1 } });
    const uncapped = await syncLocations(deps, "agency-a");
    expect(uncapped).toMatchObject({ added: 1, unchanged: 2 });
    expect(uncapped.refused).toBeUndefined();
  });

  it("only lets owners and admins connect", async () => {
    await expect(connectAgency(deps, ctx("staff", "agency-a"), STUB_CODE)).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    expect(await db.select().from(agencyGhlConnection)).toEqual([]);
  });

  it("refuses a bad code and writes nothing", async () => {
    await expect(connectAgency(deps, ctx("owner", "agency-a"), "forged")).rejects.toBeInstanceOf(
      GhlError,
    );
    expect(secrets.values.size).toBe(0);
    expect(await registry("agency-a")).toEqual([]);
  });

  it("won't connect one GHL agency to two Locus agencies", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    await expect(connectAgency(deps, ctx("other", "agency-b"), STUB_CODE)).rejects.toBeInstanceOf(
      ConnectError,
    );
    expect(await registry("agency-b")).toEqual([]);
    expect(await secrets.get(ghlSecretRef("agency-b"))).toBeUndefined();
  });

  it("refuses a sub-account install — Locus connects at the agency level", async () => {
    const fake = createFakeGhl({
      "POST /oauth/token": {
        body: {
          access_token: "t",
          refresh_token: "r",
          expires_in: 86400,
          userType: "Location",
          companyId: "c",
          locationId: "l",
          userId: "u",
        },
      },
    });
    const exchange = exchangeCode(ghl, "code", { fetch: fake.fetch });
    await expect(exchange).rejects.toBeInstanceOf(ConnectError);
    await expect(exchange).rejects.toThrow(/pick your agency/);
    expect(fake.requests[0]?.body).toMatchObject({
      grant_type: "authorization_code",
      user_type: "Company",
      client_id: "client-id",
    });
  });

  it("renews the agency token once it is close to expiring", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    const first = await agencyToken(deps, "agency-a");
    clock += 24 * 3_600_000;
    const renewed = await agencyToken(deps, "agency-a");
    expect(renewed.token).not.toBe(first.token);
    expect(await secrets.get(ghlSecretRef("agency-a"))).toContain(renewed.token);
  });
});

describe("sub-account sessions", () => {
  /** Every request the stub GHL saw, as "METHOD /path". */
  let seen: string[];
  beforeEach(async () => {
    const stub = createStubGhl(agency);
    seen = [];
    deps.http = {
      baseUrl: "https://stub.ghl.test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
        return stub(input, init);
      }) as typeof fetch,
    };
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
  });
  const clientNamed = async (name: string) => {
    const row = (await registry("agency-a")).find((l) => l.name === name);
    if (!row) throw new Error(`no client ${name}`);
    return row;
  };

  it("mints the sub-account's own token from the agency token, after the staff check", async () => {
    const harbor = await clientNamed("Harbor Realty");
    const client = await authorizeClient(db, ctx("owner", "agency-a"), harbor.id);
    seen = [];
    const session = await clientGhlSession(deps, client);
    expect(session).toMatchObject({
      tokenKind: "location",
      locationId: harbor.ghlLocationId,
      companyId: "stub-company-1",
    });
    expect(session.token).toMatch(/^stub-location-token-stub-location-3-/);
    expect(seen).toEqual(["POST /oauth/location-token"]);

    expect(await checkClientGhl(deps, client)).toEqual({ name: "Harbor Realty" });
  });

  it("asks GHL for nothing, not even a token, for a Media Library write the scopes don't allow", async () => {
    const harbor = await clientNamed("Harbor Realty");
    const client = await authorizeClient(db, ctx("owner", "agency-a"), harbor.id);
    // The stub's grant has no medias.write, and the agency token is due for renewal: a mint
    // would renew it and then mint, so either would show up below.
    clock += 24 * 3_600_000;
    const crm = siteCrm(async () => ({
      ...(await clientGhl(deps, client)),
      ...(deps.http ? { http: deps.http } : {}),
    }));
    seen = [];
    await expect(
      crm.saveImage({
        siteId: "site-1",
        name: "hero.png",
        bytes: new Uint8Array([137, 80, 78, 71]),
        contentType: "image/png",
      }),
    ).rejects.toBeInstanceOf(CrmMediaError);
    expect(seen).toEqual([]);

    // The session is minted when a call needs it, for the authorized client only.
    const { session, scopes } = await clientGhl(deps, client);
    expect(scopes).toEqual(["locations.readonly", "oauth.readonly", "oauth.write"]);
    expect(seen).toEqual([]);
    expect(await session()).toMatchObject({ locationId: harbor.ghlLocationId });
    expect(seen).toEqual(["POST /oauth/token", "POST /oauth/location-token"]);

    const forged: AuthorizedClient = {
      location: { ...harbor, siteBuilder: true },
      memberId: "owner@agency-a",
    };
    seen = [];
    await expect(clientGhl(deps, forged)).rejects.toBeInstanceOf(ClientAccessDenied);
    expect(seen).toEqual([]);
  });

  it("never stores the sub-account token", async () => {
    const harbor = await clientNamed("Harbor Realty");
    await clientGhlSession(deps, await authorizeClient(db, ctx("owner", "agency-a"), harbor.id));
    expect(JSON.stringify([...secrets.values.values()])).not.toContain("stub-location-token");
    const tables = await db.$client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    );
    for (const { name } of tables.rows) {
      const rows = await db.$client.execute(`select * from "${name}"`);
      expect(JSON.stringify(rows.rows)).not.toContain("stub-location-token");
    }
  });

  it("refuses a client that didn't come from the staff check, before asking GHL", async () => {
    const harbor = await clientNamed("Harbor Realty");
    const forged: AuthorizedClient = {
      location: { ...harbor, siteBuilder: true },
      memberId: "owner@agency-a",
    };
    seen = [];
    await expect(clientGhlSession(deps, forged)).rejects.toBeInstanceOf(ClientAccessDenied);
    expect(seen).toEqual([]);
  });

  it("a restricted member gets nothing minted for a client off their list", async () => {
    const harbor = await clientNamed("Harbor Realty");
    seen = [];
    await expect(authorizeClient(db, ctx("staff", "agency-a"), harbor.id)).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    expect(seen).toEqual([]);
  });

  it("passes on GHL refusing, e.g. Locus no longer installed there", async () => {
    const harbor = await clientNamed("Harbor Realty");
    const client = await authorizeClient(db, ctx("owner", "agency-a"), harbor.id);
    agency.locations = agency.locations.filter((l) => l.name !== "Harbor Realty");
    await expect(clientGhlSession(deps, client)).rejects.toBeInstanceOf(GhlError);
  });
});

describe("GHL webhooks", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signed = (body: string) => sign(null, Buffer.from(body), privateKey).toString("base64");

  it("accepts only bodies signed with GHL's key", () => {
    const body = JSON.stringify({ type: "INSTALL", companyId: "c" });
    expect(verifyGhlSignature(body, signed(body), publicKeyB64)).toBe(true);
    expect(verifyGhlSignature(`${body} `, signed(body), publicKeyB64)).toBe(false);
    expect(verifyGhlSignature(body, null, publicKeyB64)).toBe(false);
    expect(verifyGhlSignature(body, "not-base64!!", publicKeyB64)).toBe(false);
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyGhlSignature(body, signed(body), pem)).toBe(true);
  });

  it("adds a client installed later, suspends an uninstalled one, and brings it back", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    agency.locations.push({ _id: "stub-location-4", name: "Cedar Law" });

    const install = { type: "INSTALL", appId: "app-id", companyId: "stub-company-1" };
    expect(await handleGhlWebhook(deps, { ...install, locationId: "stub-location-4" })).toBe(
      "synced",
    );
    expect(await registry("agency-a")).toHaveLength(4);

    const uninstall = { type: "UNINSTALL", appId: "app-id", companyId: "stub-company-1" };
    expect(await handleGhlWebhook(deps, { ...uninstall, locationId: "stub-location-4" })).toBe(
      "location-suspended",
    );
    const visible = await listAccessibleClients(db, ctx("owner", "agency-a"));
    expect(visible.map((l) => l.name)).not.toContain("Cedar Law");

    await handleGhlWebhook(deps, { ...install, locationId: "stub-location-4" });
    const back = await listAccessibleClients(db, ctx("owner", "agency-a"));
    expect(back.map((l) => l.name)).toContain("Cedar Law");
  });

  it("records white-label branding from the install", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    await handleGhlWebhook(deps, {
      type: "INSTALL",
      appId: "app-id",
      companyId: "stub-company-1",
      companyName: "Acme Marketing",
      isWhitelabelCompany: true,
      whitelabelDetails: { domain: "app.acme.test", logoUrl: "https://acme.test/logo.png" },
    });
    const [connection] = await db.select().from(agencyGhlConnection);
    expect(connection).toMatchObject({
      companyName: "Acme Marketing",
      isWhitelabel: true,
      whitelabelDomain: "app.acme.test",
    });
  });

  it("suspends everything and drops the tokens when the agency uninstalls", async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
    expect(
      await handleGhlWebhook(deps, {
        type: "UNINSTALL",
        appId: "app-id",
        companyId: "stub-company-1",
      }),
    ).toBe("agency-uninstalled");
    expect((await registry("agency-a")).every((l) => l.status === "suspended")).toBe(true);
    expect(await secrets.get(ghlSecretRef("agency-a"))).toBeUndefined();
  });

  it("ignores other apps, other events and agencies that never connected", async () => {
    expect(
      await handleGhlWebhook(deps, { type: "INSTALL", appId: "someone-else", companyId: "x" }),
    ).toBe("ignored");
    expect(await handleGhlWebhook(deps, { type: "ContactCreate", companyId: "x" })).toBe("ignored");
    expect(await handleGhlWebhook(deps, { type: "INSTALL", appId: "app-id", companyId: "x" })).toBe(
      "unknown-agency",
    );
    expect(await registry("agency-a")).toEqual([]);
  });
});

describe("importing staff access from GHL", () => {
  beforeEach(async () => {
    await connectAgency(deps, ctx("owner", "agency-a"), STUB_CODE);
  });

  it("gives a restricted GHL user's sub-accounts to the matching Locus member", async () => {
    await addMember("sam", "agency-a", "member");
    await db.update(user).set({ email: "Sam@Stub-Agency.test" }).where(eq(user.id, "sam"));
    const report = await importStaffAccess(deps, ctx("owner", "agency-a"));
    expect(report.updated).toEqual([
      { email: "Sam@Stub-Agency.test", clients: 2, everyClient: false },
    ]);
    const names = (await listAccessibleClients(db, ctx("sam", "agency-a"))).map((l) => l.name);
    expect(names.sort()).toEqual(["Harbor Realty", "Sunrise Dental"]);
  });

  it("gives every client to a member GHL lets see everything, and never changes roles", async () => {
    await addMember("avery", "agency-a", "member");
    await db.update(user).set({ email: "avery@stub-agency.test" }).where(eq(user.id, "avery"));
    const report = await importStaffAccess(deps, ctx("owner", "agency-a"));
    expect(report.updated[0]).toMatchObject({ clients: 3, everyClient: true });
    const [row] = await db.select().from(member).where(eq(member.id, "avery@agency-a"));
    expect(row?.role).toBe("member");
  });

  it("leaves owners, admins and members missing from GHL alone, and counts GHL-only staff", async () => {
    await db.update(user).set({ email: "avery@stub-agency.test" }).where(eq(user.id, "owner"));
    const report = await importStaffAccess(deps, ctx("owner", "agency-a"));
    expect(report.managers).toEqual(["avery@stub-agency.test"]);
    expect(report.notInGhl).toEqual(["staff@agency.test"]);
    expect(report.ghlOnly).toBe(1);
    expect(report.updated).toEqual([]);
  });

  it("only lets owners and admins import", async () => {
    await expect(importStaffAccess(deps, ctx("staff", "agency-a"))).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
  });

  it("asks GHL for agency staff only, all pages", async () => {
    agency.users = Array.from({ length: 150 }, (_, i) => ({
      id: `u${i}`,
      name: `u${i}`,
      email: `u${i}@stub-agency.test`,
      roles: { type: "agency", role: "user", locationIds: [], restrictSubAccount: true },
    }));
    agency.users.push({
      id: "client-owner",
      name: "Client Owner",
      email: "owner@sunrise.test",
      roles: {
        type: "account",
        role: "admin",
        locationIds: ["stub-location-1"],
        restrictSubAccount: true,
      },
    });
    const staff = await listAgencyStaff(deps, await agencyToken(deps, "agency-a"));
    expect(staff).toHaveLength(150);
    expect(staff.some((u) => u.email === "owner@sunrise.test")).toBe(false);
  });
});
