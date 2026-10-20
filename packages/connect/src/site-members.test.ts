import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, type SessionContext } from "@locus/auth";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import { agencyGhlConnection, location, member, organization, site, user } from "@locus/db/control";
import { createRateLimiter } from "@locus/ghl";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import type { GhlAppConfig } from "./ghl-oauth.ts";
import { enableSiteBackend } from "./site-backend.ts";
import { type SiteFilesDeps, siteFilesKey } from "./site-files.ts";
import { siteMemberSignedUp } from "./site-members.ts";

// Level-1 plumbing: the fake GHL plays the client's contacts. No model is on this path.

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["contacts.write"],
};

const KEY = new Uint8Array(32).fill(7);
const SITE = "6f1d2c3a-0000-4000-8000-000000000001";
const OTHER = "6f1d2c3a-0000-4000-8000-000000000002";
const CLOCK = Date.parse("2026-10-20T12:00:00Z");
const ctx: SessionContext = { id: "s-owner", userId: "owner", activeOrganizationId: "agency-a" };
const bearer = (siteId: string) => `Bearer ${siteFilesKey(KEY, siteId)}`;

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let fake: FakeGhl;
let scopes: string;

const routes: FakeRoutes = {
  "POST /oauth/location-token": (req) => ({
    body: {
      access_token: `location-token-${(req.body as { locationId: string }).locationId}`,
      locationId: (req.body as { locationId: string }).locationId,
    },
  }),
  "POST /contacts/upsert": { body: { new: true, contact: { id: "contact-1" } } },
  "PUT /contacts/contact-1": { body: { succeeded: true, contact: { id: "contact-1" } } },
  "POST /contacts/contact-1/tags": { status: 201, body: { tags: ["website lead"] } },
};

function deps(given: FakeRoutes = routes): SiteFilesDeps {
  fake = createFakeGhl(given);
  return {
    db,
    secrets,
    ghl,
    http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
    now: () => CLOCK,
    rateLimiter: createRateLimiter(),
    filesKey: KEY,
    ipHashKey: Buffer.alloc(32, 3),
  };
}

const signUp = (
  d: SiteFilesDeps,
  body: unknown = { email: "Sam@Example.test", name: "Sam Member" },
  authorization: string | null = bearer(SITE),
  visitorIp: string | null = "203.0.113.9",
) => siteMemberSignedUp(d, { siteId: SITE, authorization, body, visitorIp });

const paths = () => fake.requests.map((r) => `${r.method} ${r.url.pathname}`);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-files-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  scopes = "contacts.write oauth.write";
  const now = new Date(CLOCK);
  await db.insert(organization).values({ id: "agency-a", name: "a", slug: "a", createdAt: now });
  await db
    .insert(user)
    .values({ id: "owner", name: "owner", email: "owner@agency.test", emailVerified: true });
  await db.insert(member).values({
    id: "owner@agency-a",
    userId: "owner",
    organizationId: "agency-a",
    role: "owner",
    createdAt: now,
  });
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
  await db.insert(site).values({ id: SITE, locationId: "client-1", status: "deployed" });
  await db.insert(site).values({ id: OTHER, locationId: "client-2", status: "deployed" });
  const owner = await authorizeClient(db, ctx, "client-1");
  await enableSiteBackend({ db, provisioner: new LocalProvisioner(join(dir, "dbs")) }, ctx, owner, {
    siteId: SITE,
  });
  await secrets.set(
    ghlSecretRef("agency-a"),
    JSON.stringify({
      accessToken: "agency-token",
      refreshToken: "refresh-token",
      expiresAt: CLOCK + 24 * 3_600_000,
      scopes,
      companyId: "company-1",
      installedBy: "user-1",
    }),
  );
  await db.insert(agencyGhlConnection).values({
    organizationId: "agency-a",
    ghlCompanyId: "company-1",
    scopes,
    secretRef: ghlSecretRef("agency-a"),
    connectedAt: new Date(CLOCK),
  });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a member who signs up on a site", () => {
  it("becomes a contact in the site's own sub-account, tagged as a sign-up", async () => {
    expect(await signUp(deps())).toEqual({ status: 200, body: { ok: true } });
    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "PUT /contacts/contact-1",
    ]);
    const [mint, upsert, tags, update] = fake.requests;
    // The sub-account comes from the site's registry row, never the request.
    expect(mint?.body).toMatchObject({ locationId: "ghl-client-1", companyId: "company-1" });
    expect(upsert?.body).toEqual({ locationId: "ghl-client-1", email: "Sam@Example.test" });
    expect(tags?.body).toEqual({ tags: ["website lead", "website form: sign-up"] });
    expect(update?.body).toEqual({ name: "Sam Member", source: "Website form (sign-up)" });
  });

  it("never changes an existing contact's name, and notes the one the member gave", async () => {
    const d = deps({
      ...routes,
      "POST /contacts/upsert": {
        body: { new: false, contact: { id: "contact-1", name: "Samantha M", source: "Ads" } },
      },
      "POST /contacts/contact-1/notes": { status: 201, body: { note: { id: "note-1" } } },
    });
    expect((await signUp(d)).status).toBe(200);
    expect(paths()).not.toContain("PUT /contacts/contact-1");
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(JSON.stringify(note?.body)).toContain("Sam Member");
  });

  it("refuses a site without its own key, or another site's", async () => {
    const d = deps();
    expect((await signUp(d, undefined, null)).status).toBe(401);
    expect((await signUp(d, undefined, bearer(OTHER))).status).toBe(401);
    expect((await signUp(d, undefined, "Bearer nope")).status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it("needs the member's email", async () => {
    const d = deps();
    expect((await signUp(d, { name: "No Email" })).status).toBe(400);
    expect((await signUp(d, { email: "not an email" })).status).toBe(400);
    expect((await signUp(d, null)).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("says so when the HighLevel connection can't add contacts", async () => {
    scopes = "medias.write oauth.write";
    await secrets.set(
      ghlSecretRef("agency-a"),
      JSON.stringify({
        accessToken: "agency-token",
        refreshToken: "refresh-token",
        expiresAt: CLOCK + 24 * 3_600_000,
        scopes,
        companyId: "company-1",
        installedBy: "user-1",
      }),
    );
    await db.update(agencyGhlConnection).set({ scopes });
    const d = deps();
    expect((await signUp(d)).status).toBe(403);
    expect(paths()).not.toContain("POST /contacts/upsert");
  });

  it("holds back a flood of sign-ups from one visitor", async () => {
    const d = deps();
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await signUp(d, { email: `m${i}@example.test` }));
    expect(answers.slice(0, 5).every((a) => a.status === 200)).toBe(true);
    expect(answers[5]).toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
  });

  it("answers 502, and logs only what failed, when HighLevel refuses", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ ...routes, "POST /contacts/upsert": { status: 500, body: { message: "x" } } });
    expect((await signUp(d)).status).toBe(502);
    expect(JSON.stringify(error.mock.calls)).not.toContain("Sam@Example.test");
    error.mockRestore();
  });
});
