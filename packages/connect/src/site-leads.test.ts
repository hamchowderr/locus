import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import {
  agencyGhlConnection,
  authRateLimit,
  location,
  organization,
  site,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import type { GhlAppConfig } from "./ghl-oauth.ts";
import { type SiteLeadDeps, type SiteLeadInput, submitSiteLead } from "./site-leads.ts";
import { createStubGhl, STUB_AGENCY } from "./stub.ts";

// Level-1 plumbing: the fake GHL plays GoHighLevel; no model is involved on this path (a lead
// never reaches an agent from here), so there is nothing for AIMock to play.

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["contacts.write", "oauth.write"],
};

const CLOCK = Date.parse("2026-10-14T12:00:00Z");
const GHL_LOCATION = "ghl-loc-sunrise";
const OTHER_GHL_LOCATION = "ghl-loc-harbor";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let fake: FakeGhl;
let clock: number;

const okRoutes: FakeRoutes = {
  "POST /oauth/location-token": (req) => ({
    body: {
      access_token: `location-token-${(req.body as { locationId: string }).locationId}`,
      locationId: (req.body as { locationId: string }).locationId,
    },
  }),
  "POST /contacts/upsert": { body: { new: true, contact: { id: "contact-1" } } },
  "POST /contacts/contact-1/tags": { status: 201, body: { tags: ["website lead"] } },
  "POST /contacts/contact-1/notes": { status: 201, body: { note: { id: "note-1" } } },
};

function deps(routes: FakeRoutes = okRoutes, extra: Partial<SiteLeadDeps> = {}): SiteLeadDeps {
  fake = createFakeGhl(routes);
  return {
    db,
    secrets,
    ghl,
    http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
    now: () => clock,
    ...extra,
  };
}

const lead = {
  name: "Dana Visitor",
  email: "dana@example.test",
  phone: "+1 555 010 0199",
  message: "Do you take new patients?",
  form: "contact",
  page: "/contact",
  fax: "",
  elapsedMs: 8_000,
};

const submit = (d: SiteLeadDeps, body: unknown, over: Partial<SiteLeadInput> = {}) =>
  submitSiteLead(d, {
    siteId: "site-live",
    raw: typeof body === "string" ? body : JSON.stringify(body),
    visitorIp: "203.0.113.7",
    ...over,
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-leads-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  clock = CLOCK;
  const createdAt = new Date();
  await db
    .insert(organization)
    .values({ id: "agency-a", name: "Agency A", slug: "agency-a", createdAt });
  for (const [id, ghlLocationId] of [
    ["sunrise", GHL_LOCATION],
    ["harbor", OTHER_GHL_LOCATION],
  ] as const) {
    await db.insert(location).values({
      id,
      organizationId: "agency-a",
      ghlLocationId,
      name: id,
      tursoDbName: `db-${id}`,
      tursoDbHostname: `db-${id}.turso.test`,
      status: "active",
    });
  }
  await db.insert(site).values([
    { id: "site-live", locationId: "sunrise", status: "deployed", repoFullName: "a/live" },
    { id: "site-pushed", locationId: "sunrise", status: "pushed", repoFullName: "a/pushed" },
    { id: "site-draft", locationId: "sunrise", status: "draft" },
  ]);
  await secrets.set(
    ghlSecretRef("agency-a"),
    JSON.stringify({
      accessToken: "agency-token",
      refreshToken: "refresh-token",
      expiresAt: CLOCK + 24 * 3_600_000,
      scopes: "contacts.write oauth.write",
      companyId: "company-1",
      installedBy: "user-1",
    }),
  );
  await db.insert(agencyGhlConnection).values({
    organizationId: "agency-a",
    ghlCompanyId: "company-1",
    scopes: "contacts.write oauth.write",
    secretRef: ghlSecretRef("agency-a"),
    connectedAt: new Date(CLOCK),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const paths = () => fake.requests.map((r) => `${r.method} ${r.url.pathname}`);

describe("a published site's lead form", () => {
  it("upserts the contact in the site's own sub-account, tags it and notes the message", async () => {
    const d = deps();
    expect(await submit(d, lead)).toEqual({ status: 200, body: { ok: true } });

    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "POST /contacts/contact-1/notes",
    ]);
    const [mint, upsert, tags, note] = fake.requests;
    // The sub-account comes from the site's registry row, minted with the agency token.
    expect(mint?.body).toMatchObject({ locationId: GHL_LOCATION, companyId: "company-1" });
    expect(mint?.headers.authorization).toBe("Bearer agency-token");
    expect(upsert?.headers.authorization).toBe(`Bearer location-token-${GHL_LOCATION}`);
    expect(upsert?.headers.version).toBe("v3");
    expect(upsert?.body).toEqual({
      locationId: GHL_LOCATION,
      name: "Dana Visitor",
      email: "dana@example.test",
      phone: "+1 555 010 0199",
      source: "Website form (contact)",
    });
    expect(tags?.body).toEqual({ tags: ["website lead", "website form: contact"] });
    expect(note?.body).toEqual({
      title: "Website form: contact",
      body: "Do you take new patients?\n\nPage: /contact",
    });
  });

  it("accepts a site that is pushed but not yet seen deployed", async () => {
    const d = deps();
    expect((await submit(d, lead, { siteId: "site-pushed" })).status).toBe(200);
    expect(paths()).toContain("POST /contacts/upsert");
  });

  it("puts a form's extra answers in the note, never in a contact field", async () => {
    const d = deps();
    const result = await submit(d, {
      ...lead,
      message: undefined,
      form: "quote-request",
      service: "Whitening",
    });
    expect(result.status).toBe(200);
    const upsert = fake.requests.find((r) => r.url.pathname === "/contacts/upsert");
    expect(upsert?.body).not.toHaveProperty("service");
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toEqual({
      title: "Website form: quote-request",
      body: "service: Whitening\nPage: /contact",
    });
  });

  it("refuses an unknown site and a draft one alike, before asking GHL", async () => {
    const d = deps();
    for (const siteId of ["no-such-site", "site-draft", "../../etc"]) {
      expect(await submit(d, lead, { siteId })).toEqual({
        status: 404,
        body: { error: "This form isn't connected." },
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it("refuses a suspended client's site", async () => {
    await db.update(location).set({ status: "suspended" }).where(eq(location.id, "sunrise"));
    const d = deps();
    expect((await submit(d, lead)).status).toBe(404);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a request that names a location, company or contact, and sends nothing", async () => {
    const d = deps();
    for (const field of ["locationId", "location_id", "LocationID", "companyId", "contactId"]) {
      const result = await submit(d, { ...lead, [field]: OTHER_GHL_LOCATION });
      expect(result).toEqual({
        status: 400,
        body: { error: "That form sends a field Locus doesn't accept." },
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it("can't steer tags, source or custom fields either", async () => {
    const d = deps();
    for (const field of ["tags", "source", "customFields", "assignedTo"]) {
      expect((await submit(d, { ...lead, [field]: "x" })).status).toBe(400);
    }
    expect(fake.requests).toEqual([]);
  });

  it("says a filled honeypot went through, and sends nothing", async () => {
    const d = deps();
    expect(await submit(d, { ...lead, fax: "555-0100" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(fake.requests).toEqual([]);
  });

  it("says a too-fast (or untimed) submission went through, and sends nothing", async () => {
    const d = deps();
    expect((await submit(d, { ...lead, elapsedMs: 900 })).status).toBe(200);
    expect((await submit(d, { ...lead, elapsedMs: undefined })).status).toBe(200);
    expect((await submit(d, { ...lead, elapsedMs: "soon" })).status).toBe(200);
    expect(fake.requests).toEqual([]);
  });

  it("limits each visitor IP per site, then the site as a whole", async () => {
    const d = deps(okRoutes, {
      limits: {
        perIp: { max: 2, windowMs: 10 * 60_000 },
        perSite: { max: 3, windowMs: 60 * 60_000 },
      },
    });
    expect((await submit(d, lead)).status).toBe(200);
    expect((await submit(d, lead)).status).toBe(200);
    const limited = await submit(d, lead);
    expect(limited).toMatchObject({ status: 429, retryAfterSeconds: 600 });
    expect(fake.requests.filter((r) => r.url.pathname === "/contacts/upsert")).toHaveLength(2);

    // Another visitor still gets through, until the site's own ceiling.
    expect((await submit(d, lead, { visitorIp: "198.51.100.4" })).status).toBe(429);
    expect(fake.requests.filter((r) => r.url.pathname === "/contacts/upsert")).toHaveLength(2);

    // A new window lets them back in.
    clock += 60 * 60_000;
    expect((await submit(d, lead, { visitorIp: "198.51.100.4" })).status).toBe(200);
  });

  it("counts bots against the limits too, and keeps no visitor IP in clear", async () => {
    const d = deps(okRoutes, { limits: { perIp: { max: 1, windowMs: 10 * 60_000 } } });
    expect((await submit(d, { ...lead, fax: "bot" })).status).toBe(200);
    expect((await submit(d, lead)).status).toBe(429);
    const keys = (await db.select().from(authRateLimit)).map((r) => r.key);
    expect(keys.some((k) => k.startsWith("site-lead|ip|site-live|"))).toBe(true);
    expect(JSON.stringify(keys)).not.toContain("203.0.113.7");
  });

  it("without a usable visitor IP, only the per-site limit applies", async () => {
    const d = deps(okRoutes, { limits: { perIp: { max: 1, windowMs: 10 * 60_000 } } });
    for (const visitorIp of [null, "not-an-ip", null]) {
      expect((await submit(d, lead, { visitorIp })).status).toBe(200);
    }
  });

  it("refuses oversized fields, bodies and too many fields, before asking GHL", async () => {
    const d = deps();
    expect(await submit(d, { ...lead, message: "x".repeat(5_001) })).toEqual({
      status: 400,
      body: { error: "That message is too long." },
    });
    expect((await submit(d, { ...lead, name: "n".repeat(121) })).status).toBe(400);
    expect((await submit(d, { ...lead, email: `${"e".repeat(250)}@x.test` })).status).toBe(400);
    expect((await submit(d, { ...lead, extra: "v".repeat(1_001) })).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`q${i}`, "a"]));
    expect((await submit(d, { ...lead, ...many })).status).toBe(400);
    expect((await submit(d, "x".repeat(17 * 1024))).status).toBe(413);
    expect(fake.requests).toEqual([]);
  });

  it("refuses bodies that aren't a flat set of text answers", async () => {
    const d = deps();
    expect((await submit(d, "not json")).status).toBe(400);
    expect((await submit(d, [lead])).status).toBe(400);
    expect((await submit(d, { ...lead, name: { first: "D" } })).status).toBe(400);
    expect((await submit(d, { ...lead, email: "nope" })).status).toBe(400);
    expect((await submit(d, { ...lead, email: undefined, phone: undefined })).status).toBe(400);
    expect((await submit(d, { ...lead, phone: "call me" })).status).toBe(400);
    expect((await submit(d, { ...lead, form: "Quote Request!" })).status).toBe(400);
    expect((await submit(d, { ...lead, "bad key": "v" })).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("strips control characters and keeps a message's line breaks", async () => {
    const d = deps();
    await submit(d, { ...lead, name: "Dana\u0000 Visitor\u001b", message: "Line 1\r\nLine 2" });
    const upsert = fake.requests.find((r) => r.url.pathname === "/contacts/upsert");
    expect(upsert?.body).toMatchObject({ name: "Dana Visitor" });
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toMatchObject({ body: "Line 1\nLine 2\n\nPage: /contact" });
  });

  it("tells the visitor nothing about a GHL error, and logs no personal data", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "Contact dana@example.test duplicates sk-internal-detail";
    for (const failing of [
      { "POST /contacts/upsert": { status: 422, body: { statusCode: 422, message: secret } } },
      { "POST /contacts/contact-1/tags": { status: 500, body: { message: secret } } },
      { "POST /contacts/contact-1/notes": { status: 401, body: { message: secret } } },
      { "POST /oauth/location-token": { status: 400, body: { message: secret } } },
      { "POST /contacts/upsert": { body: { contact: {} } } },
    ] as FakeRoutes[]) {
      const d = deps({ ...okRoutes, ...failing });
      const result = await submit(d, lead);
      expect(result).toEqual({
        status: 502,
        body: { error: "We couldn't send that just now. Please try again." },
      });
    }
    const logged = errors.mock.calls.flat().join("\n");
    expect(logged).toContain("site-live");
    expect(logged).not.toMatch(/dana|sk-internal|example\.test|agency-token|location-token-/i);
  });

  it("works against the stub GHL that GHL_MODE=stub runs", async () => {
    const stubbed: SiteLeadDeps = {
      ...deps(),
      http: { fetch: createStubGhl(STUB_AGENCY), baseUrl: "https://stub.ghl.test" },
    };
    await db
      .update(location)
      .set({ ghlLocationId: "stub-location-1" })
      .where(eq(location.id, "sunrise"));
    await db
      .update(agencyGhlConnection)
      .set({ ghlCompanyId: STUB_AGENCY.companyId })
      .where(eq(agencyGhlConnection.organizationId, "agency-a"));
    const grant = JSON.parse((await secrets.get(ghlSecretRef("agency-a"))) as string);
    await secrets.set(
      ghlSecretRef("agency-a"),
      JSON.stringify({ ...grant, accessToken: "stub-agency-token-1", companyId: "stub-company-1" }),
    );
    expect(await submit(stubbed, lead)).toEqual({ status: 200, body: { ok: true } });
  });

  it("never stores the sub-account token or the lead", async () => {
    const d = deps();
    await submit(d, lead);
    const tables = await db.$client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    );
    for (const { name } of tables.rows) {
      const rows = await db.$client.execute(`select * from "${name}"`);
      const text = JSON.stringify(rows.rows);
      expect(text).not.toContain("location-token");
      expect(text).not.toContain("dana@example.test");
    }
  });
});
