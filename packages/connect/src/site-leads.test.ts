import { createHash } from "node:crypto";
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
import { createRateLimiter } from "@locus/ghl";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import type { GhlAppConfig } from "./ghl-oauth.ts";
import {
  hashVisitorIp,
  MAX_LEAD_BODY_BYTES,
  readLeadBody,
  type SiteLeadDeps,
  type SiteLeadInput,
  submitSiteLead,
} from "./site-leads.ts";
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

const IP_KEY = Buffer.alloc(32, 7);
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
  "PUT /contacts/contact-1": { body: { succeeded: true, contact: { id: "contact-1" } } },
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
    ipHashKey: IP_KEY,
    // Each test gets its own GHL budget, so the file's request count can't slow later tests.
    rateLimiter: createRateLimiter(),
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
  it("creates the contact in the site's own sub-account, tags it and notes the message", async () => {
    const d = deps();
    expect(await submit(d, lead)).toEqual({ status: 200, body: { ok: true } });

    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "PUT /contacts/contact-1",
      "POST /contacts/contact-1/notes",
    ]);
    const [mint, upsert, tags, update, note] = fake.requests;
    // The sub-account comes from the site's registry row, minted with the agency token.
    expect(mint?.body).toMatchObject({ locationId: GHL_LOCATION, companyId: "company-1" });
    expect(mint?.headers.authorization).toBe("Bearer agency-token");
    expect(upsert?.headers.authorization).toBe(`Bearer location-token-${GHL_LOCATION}`);
    expect(upsert?.headers.version).toBe("v3");
    // The upsert carries only the detail it matches on; the new contact is filled in by id.
    expect(upsert?.body).toEqual({ locationId: GHL_LOCATION, email: "dana@example.test" });
    expect(update?.headers.version).toBe("v3");
    expect(update?.body).toEqual({
      name: "Dana Visitor",
      phone: "+1 555 010 0199",
      source: "Website form (contact)",
    });
    expect(tags?.body).toEqual({ tags: ["website lead", "website form: contact"] });
    expect(note?.body).toEqual({
      title: "Website form: contact",
      body: "Do you take new patients?\n\nPage: /contact",
    });
  });

  it("never changes a detail an existing contact already has, and notes what the visitor typed", async () => {
    const d = deps({
      ...okRoutes,
      "POST /contacts/upsert": {
        body: {
          new: false,
          contact: {
            id: "contact-1",
            name: "Dana Customer",
            firstName: "Dana",
            lastName: "Customer",
            email: "dana@example.test",
            phone: "+1 555 010 0100",
            companyName: "Sunrise Dental",
            source: "Referral",
          },
        },
      },
    });
    const result = await submit(d, { ...lead, companyName: "Mallory Ltd" });
    expect(result.status).toBe(200);

    // Nothing is sent that would change the contact: no update, no company upsert.
    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "POST /contacts/contact-1/notes",
    ]);
    expect(fake.requests[1]?.body).toEqual({
      locationId: GHL_LOCATION,
      email: "dana@example.test",
    });
    expect(fake.requests[3]?.body).toEqual({
      title: "Website form: contact",
      body: [
        "Do you take new patients?",
        "",
        "Also on the form (kept here, not changed on the contact):",
        "Name: Dana Visitor",
        "Phone: +1 555 010 0199",
        "Company: Mallory Ltd",
        "",
        "Page: /contact",
      ].join("\n"),
    });
  });

  it("fills only an existing contact's blank fields", async () => {
    const d = deps({
      ...okRoutes,
      "POST /contacts/upsert": {
        body: {
          new: false,
          contact: {
            id: "contact-1",
            email: "dana@example.test",
            phone: "+15550100199",
            source: "",
          },
        },
      },
    });
    await submit(d, { ...lead, phone: "555-010-0199", companyName: "Sunrise Dental" });

    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "PUT /contacts/contact-1",
      "POST /contacts/contact-1/notes",
    ]);
    const [, , , update, note] = fake.requests;
    // The phone is the CRM's without its country code, so it's neither sent nor noted.
    expect(update?.body).toEqual({ name: "Dana Visitor", source: "Website form (contact)" });
    // An existing contact's company is never set through a second upsert, which matches again
    // and could pick another contact with the same email: it goes in the note.
    expect(note?.body).toEqual({
      title: "Website form: contact",
      body: [
        "Do you take new patients?",
        "",
        "Also on the form (kept here, not changed on the contact):",
        "Company: Sunrise Dental",
        "",
        "Page: /contact",
      ].join("\n"),
    });
  });

  it("sets a new contact's company through the upsert, and checks it's the same contact", async () => {
    const d = deps();
    await submit(d, { ...lead, companyName: "Sunrise Dental" });
    const upserts = fake.requests.filter((r) => r.url.pathname === "/contacts/upsert");
    expect(upserts.map((r) => r.body)).toEqual([
      { locationId: GHL_LOCATION, email: "dana@example.test" },
      { locationId: GHL_LOCATION, email: "dana@example.test", companyName: "Sunrise Dental" },
    ]);
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toMatchObject({ body: "Do you take new patients?\n\nPage: /contact" });

    // GHL answered with another contact: the company is noted on ours too.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const other = deps({
      ...okRoutes,
      "POST /contacts/upsert": () => ({
        body: { new: true, contact: { id: calls++ === 0 ? "contact-1" : "contact-2" } },
      }),
    });
    expect((await submit(other, { ...lead, companyName: "Sunrise Dental" })).status).toBe(200);
    const noted = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(noted?.body).toMatchObject({ body: expect.stringContaining("Company: Sunrise Dental") });
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/dana|sunrise/i);
  });

  it("fills a blank email by id when the email is new to the CRM", async () => {
    // GHL matched nothing on the email, so the contact is new: everything else is filled by id.
    const d = deps();
    await submit(d, { ...lead, name: undefined });
    const update = fake.requests.find((r) => r.method === "PUT");
    expect(update?.body).toEqual({ phone: "+1 555 010 0199", source: "Website form (contact)" });
  });

  it("leaves a contact's name alone when it has any part of one", async () => {
    const d = deps({
      ...okRoutes,
      "POST /contacts/upsert": {
        body: { new: false, contact: { id: "contact-1", firstName: "Dana", source: "Referral" } },
      },
    });
    await submit(d, { ...lead, name: undefined, firstName: "Mallory", lastName: "Visitor" });
    const update = fake.requests.find((r) => r.method === "PUT");
    expect(update?.body).toEqual({ phone: "+1 555 010 0199" });
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toMatchObject({
      body: expect.stringContaining("First name: Mallory\nLast name: Visitor"),
    });
  });

  it("matches on the phone when there's no email, and fills a blank email never", async () => {
    const d = deps({
      ...okRoutes,
      "POST /contacts/upsert": {
        body: { new: false, contact: { id: "contact-1", name: "Dana Visitor", source: "Ad" } },
      },
    });
    await submit(d, { ...lead, email: undefined });
    expect(fake.requests[1]?.body).toEqual({ locationId: GHL_LOCATION, phone: "+1 555 010 0199" });
    // Name already there, source set, phone was the match: nothing to fill.
    expect(paths()).not.toContain("PUT /contacts/contact-1");
  });

  it("still takes the lead when GHL refuses a detail another contact already has", async () => {
    const d = deps({
      ...okRoutes,
      "PUT /contacts/contact-1": {
        status: 400,
        body: { statusCode: 400, message: "This phone already belongs to another contact" },
      },
    });
    expect((await submit(d, lead)).status).toBe(200);
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toMatchObject({
      body: expect.stringContaining("Name: Dana Visitor\nPhone: +1 555 010 0199"),
    });
  });

  it("still takes the lead when GHL won't accept a value (422), or the company", async () => {
    const invalid = { status: 422, body: { statusCode: 422, message: "Invalid" } };
    const cases: [string, FakeRoutes][] = [
      ["Name: Dana Visitor\nPhone: +1 555 010 0199", { "PUT /contacts/contact-1": invalid }],
      [
        "Company: Sunrise Dental",
        {
          "POST /contacts/upsert": (req) =>
            (req.body as { companyName?: string }).companyName
              ? invalid
              : { body: { new: true, contact: { id: "contact-1" } } },
        },
      ],
    ];
    for (const [noted, failing] of cases) {
      const d = deps({ ...okRoutes, ...failing });
      const result = await submit(
        d,
        { ...lead, companyName: "Sunrise Dental" },
        { visitorIp: null },
      );
      expect(result.status).toBe(200);
      expect(paths()).toContain("POST /contacts/contact-1/tags");
      const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
      expect(note?.body).toMatchObject({ body: expect.stringContaining(noted) });
    }
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
    for (const r of fake.requests) expect(r.body).not.toHaveProperty("service");
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
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await submit(d, lead)).status).toBe(200);
    expect((await submit(d, lead)).status).toBe(200);
    const limited = await submit(d, lead);
    expect(limited).toMatchObject({ status: 429, retryAfterSeconds: 600 });
    expect(fake.requests.filter((r) => r.url.pathname === "/contacts/upsert")).toHaveLength(2);

    // Another visitor still gets through, until the site's own ceiling, which is logged.
    expect((await submit(d, lead, { visitorIp: "198.51.100.4" })).status).toBe(200);
    expect(warnings).not.toHaveBeenCalled();
    expect((await submit(d, lead, { visitorIp: "198.51.100.5" })).status).toBe(429);
    expect(fake.requests.filter((r) => r.url.pathname === "/contacts/upsert")).toHaveLength(3);
    expect(warnings.mock.calls.flat().join("\n")).toMatch(/site-live.*hourly lead ceiling/);
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("198.51.100");

    // A new window lets them back in.
    clock += 60 * 60_000;
    expect((await submit(d, lead, { visitorIp: "198.51.100.4" })).status).toBe(200);
  });

  it("has a high hourly ceiling per site, not a low hard cap, and a short burst guard", async () => {
    // GHL's own burst budget runs on real time; this test moves the clock, so it stands aside.
    const d = deps(okRoutes, { rateLimiter: { acquire: async () => {}, pause: () => {} } });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 300 visitors within the hour, ten a minute, all get through.
    for (let i = 0; i < 300; i++) {
      if (i % 10 === 0) clock += 60_000;
      const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
      expect((await submit(d, lead, { visitorIp: ip })).status, `lead ${i}`).toBe(200);
    }
    expect(warnings).not.toHaveBeenCalled();
    // The 301st within the hour is refused and logged.
    expect((await submit(d, lead, { visitorIp: "192.0.2.1" })).status).toBe(429);
    expect(warnings).toHaveBeenCalledTimes(1);

    // A burst from many addresses at once stops at the burst guard.
    clock += 2 * 60 * 60_000;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await submit(d, lead, { visitorIp: `192.0.2.${i + 10}` })).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.slice(20)).toEqual([429, 429, 429, 429, 429]);
  }, 30_000);

  it("charges no limit for junk: honeypot, too fast or an unreadable body", async () => {
    const d = deps(okRoutes, {
      limits: {
        perIp: { max: 1, windowMs: 10 * 60_000 },
        perSite: { max: 1, windowMs: 60 * 60_000 },
        perSiteBurst: { max: 1, windowMs: 60_000 },
      },
    });
    for (let i = 0; i < 50; i++) {
      // Spoofed addresses too: none of it may use up the site's allowance.
      const visitorIp = `203.0.113.${i}`;
      expect((await submit(d, { ...lead, fax: "bot" }, { visitorIp })).status).toBe(200);
      expect((await submit(d, { ...lead, elapsedMs: 100 }, { visitorIp })).status).toBe(200);
      expect((await submit(d, "not json", { visitorIp })).status).toBe(400);
      expect((await submit(d, { ...lead, locationId: "x" }, { visitorIp })).status).toBe(400);
    }
    expect(await db.select().from(authRateLimit)).toEqual([]);
    expect(fake.requests).toEqual([]);
    // The one real visitor still gets through.
    expect((await submit(d, lead)).status).toBe(200);
    expect(paths()).toContain("POST /contacts/upsert");
  });

  it("keeps no visitor IP in clear, only a keyed hash", async () => {
    const d = deps();
    await submit(d, lead);
    const keys = (await db.select().from(authRateLimit)).map((r) => r.key);
    expect(keys).toContain(`site-lead|ip|site-live|${hashVisitorIp(IP_KEY, "203.0.113.7")}`);
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
    const update = fake.requests.find((r) => r.method === "PUT");
    expect(update?.body).toMatchObject({ name: "Dana Visitor" });
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toMatchObject({ body: "Line 1\nLine 2\n\nPage: /contact" });
  });

  it("tells the visitor nothing about a GHL error, and logs no personal data", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "Contact dana@example.test duplicates sk-internal-detail";
    for (const failing of [
      { "POST /contacts/upsert": { status: 422, body: { statusCode: 422, message: secret } } },
      { "POST /contacts/contact-1/tags": { status: 500, body: { message: secret } } },
      { "PUT /contacts/contact-1": { status: 500, body: { message: secret } } },
      { "POST /contacts/contact-1/notes": { status: 401, body: { message: secret } } },
      { "POST /oauth/location-token": { status: 400, body: { message: secret } } },
      { "POST /contacts/upsert": { body: { contact: {} } } },
    ] as FakeRoutes[]) {
      const d = deps({ ...okRoutes, ...failing });
      // No visitor IP, so the cases don't use up one visitor's allowance.
      const result = await submit(d, lead, { visitorIp: null });
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

describe("the visitor IP hash", () => {
  it("is an HMAC: stable under one key, different under another, not a plain SHA-256", () => {
    const ip = "203.0.113.7";
    const a = hashVisitorIp(IP_KEY, ip);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashVisitorIp(Buffer.alloc(32, 7), ip)).toBe(a);
    expect(hashVisitorIp(Buffer.alloc(32, 8), ip)).not.toBe(a);
    expect(hashVisitorIp(IP_KEY, "203.0.113.8")).not.toBe(a);
    const plain = createHash("sha256").update(ip).digest("hex");
    expect(plain.startsWith(a)).toBe(false);
    expect(a).not.toBe(plain.slice(0, 32));
  });
});

describe("reading a lead body", () => {
  /** A chunked body with no length that fails if read beyond `limit + chunk` bytes. */
  function endless(chunk: number) {
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent > MAX_LEAD_BODY_BYTES) throw new Error("read past the limit");
          controller.enqueue(new Uint8Array(chunk).fill(120));
          sent += chunk;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, sent: () => sent, cancelled: () => cancelled };
  }

  it("stops past the cap without reading the rest, whatever the length said", async () => {
    const body = endless(1_000);
    expect(await readLeadBody(body.stream)).toBeNull();
    expect(body.sent()).toBeLessThanOrEqual(MAX_LEAD_BODY_BYTES + 1_000);
    expect(body.cancelled()).toBe(true);
  });

  it("refuses a chunked oversized Request whose Content-Length lies (the route answers 413)", async () => {
    const body = endless(4_096);
    const request = new Request("https://locus.test/api/sites/site-live/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: body.stream,
      duplex: "half",
    } as RequestInit);
    expect(await readLeadBody(request.body)).toBeNull();
    expect(body.sent()).toBeLessThanOrEqual(MAX_LEAD_BODY_BYTES + 4_096);
  });

  it("reads a body within the cap, split across chunks, as UTF-8", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "Zoë" }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    expect(await readLeadBody(stream)).toBe('{"name":"Zoë"}');
    expect(await readLeadBody(null)).toBe("");
  });
});
