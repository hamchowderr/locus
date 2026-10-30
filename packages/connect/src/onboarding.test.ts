import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionContext } from "@locus/auth";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import {
  agencyOnboarding,
  githubInstallation,
  hostConnection,
  location,
  member,
  organization,
  user,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectDeps, connectAgency, connectAgencyGrant, inspectGrant } from "./agency.ts";
import { exchangeCode, type GhlAppConfig } from "./ghl-oauth.ts";
import {
  beginOnboarding,
  mainClientOf,
  onboardingStep,
  setMainClient,
  skipOnboardingStep,
} from "./onboarding.ts";
import { createStubGhl, STUB_AGENCY, STUB_CODE } from "./stub.ts";

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: [],
};
const now = new Date("2026-10-26T12:00:00Z");

let dir: string;
let db: ControlDb;
let deps: ConnectDeps;
const owner: SessionContext = { id: "s-owner", userId: "owner", activeOrganizationId: "agency-a" };

async function addAgency(id: string, userId: string) {
  await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@a.test`, emailVerified: true })
    .onConflictDoNothing();
  await db
    .insert(member)
    .values({ id: `${userId}@${id}`, userId, organizationId: id, role: "owner", createdAt: now });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-onboarding-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  deps = {
    db,
    secrets: new MemorySecretStore(),
    provisioner: new LocalProvisioner(join(dir, "tenants")),
    ghl,
    http: { fetch: createStubGhl(), baseUrl: "https://stub.ghl.test" },
    migrations: [],
  };
  await addAgency("agency-a", "owner");
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a new agency's setup", () => {
  it("goes GoHighLevel, main sub-account, GitHub, Vercel, then is done for good", async () => {
    await beginOnboarding(db, "agency-a");
    expect(await onboardingStep(db, "agency-a")).toBe("ghl");

    await connectAgency(deps, owner, STUB_CODE);
    expect(await onboardingStep(db, "agency-a")).toBe("main");

    const [first] = await db.select().from(location).where(eq(location.organizationId, "agency-a"));
    expect(await setMainClient(db, "agency-a", first?.id as string)).toBe(true);
    expect(await mainClientOf(db, "agency-a")).toBe(first?.id);
    expect(await onboardingStep(db, "agency-a")).toBe("github");

    await db.insert(githubInstallation).values({
      organizationId: "agency-a",
      installationId: "1",
      orgLogin: "acme",
      connectedAt: now,
    });
    expect(await onboardingStep(db, "agency-a")).toBe("vercel");

    await db.insert(hostConnection).values({
      organizationId: "agency-a",
      provider: "vercel",
      teamId: "team_1",
      secretRef: "/x",
      connectedAt: now,
    });
    expect(await onboardingStep(db, "agency-a", { now })).toBeNull();
    const [row] = await db.select().from(agencyOnboarding);
    expect(row?.completedAt).toEqual(now);

    // Disconnecting GitHub afterwards never sends anyone back through the setup.
    await db.delete(githubInstallation);
    expect(await onboardingStep(db, "agency-a")).toBeNull();
  });

  it("GitHub and Vercel can be left for later", async () => {
    await beginOnboarding(db, "agency-a");
    await connectAgency(deps, owner, STUB_CODE);
    const [first] = await db.select().from(location);
    await setMainClient(db, "agency-a", first?.id as string);
    await skipOnboardingStep(db, "agency-a", "github");
    expect(await onboardingStep(db, "agency-a")).toBe("vercel");
    await skipOnboardingStep(db, "agency-a", "vercel");
    expect(await onboardingStep(db, "agency-a")).toBeNull();
  });

  it("an agency from before the setup is never sent through it", async () => {
    expect(await onboardingStep(db, "agency-a")).toBeNull();
  });

  it("the main sub-account must be the agency's own", async () => {
    await beginOnboarding(db, "agency-a");
    await addAgency("agency-b", "other");
    await connectAgency(
      deps,
      { id: "s-other", userId: "other", activeOrganizationId: "agency-b" },
      STUB_CODE,
    ).catch(() => undefined);
    await db.insert(location).values({
      id: "theirs",
      organizationId: "agency-b",
      ghlLocationId: "elsewhere",
      name: "Not yours",
      tursoDbName: "x",
      tursoDbHostname: "x",
      status: "active",
    });
    expect(await setMainClient(db, "agency-a", "theirs")).toBe(false);
    expect(await mainClientOf(db, "agency-a")).toBeNull();
  });
});

describe("a grant read before its agency exists", () => {
  it("names the GHL agency and says whether another Locus agency holds it", async () => {
    const grant = await exchangeCode(ghl, STUB_CODE, deps.http);
    expect(await inspectGrant(deps, grant)).toEqual({
      companyName: STUB_AGENCY.name,
      claimedBy: null,
    });
    await connectAgencyGrant(deps, owner, grant);
    expect(await inspectGrant(deps, grant)).toEqual({
      companyName: STUB_AGENCY.name,
      claimedBy: "agency-a",
    });
  });
});
