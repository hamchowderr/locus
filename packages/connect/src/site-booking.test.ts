import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { agencyGhlConnection, location, organization, site } from "@locus/db/control";
import { createRateLimiter } from "@locus/ghl";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import type { GhlAppConfig } from "./ghl-oauth.ts";
import { bookSiteAppointment, type SlotQuery, siteSlots } from "./site-booking.ts";
import { listCalendars } from "./site-crm.ts";
import type { SiteLeadDeps } from "./site-leads.ts";

// Level-1 plumbing: the fake GHL plays GoHighLevel. A booking never reaches an agent from
// this path, so there is nothing for AIMock to play.

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["calendars.readonly", "oauth.write"],
};

const CLOCK = Date.parse("2026-10-14T12:00:00Z");
const GHL_LOCATION = "ghl-loc-sunrise";
const SLOT = "2026-10-15T10:00:00-04:00";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let fake: FakeGhl;

const calendar = (locationId = GHL_LOCATION, isActive = true) => ({
  body: { calendar: { id: "cal1", locationId, name: "Consultation", isActive } },
});

const okRoutes: FakeRoutes = {
  "POST /oauth/location-token": (req) => ({
    body: {
      access_token: `location-token-${(req.body as { locationId: string }).locationId}`,
      locationId: (req.body as { locationId: string }).locationId,
    },
  }),
  "GET /calendars/cal1": calendar(),
  "GET /calendars/cal1/free-slots": {
    body: {
      "2026-10-15": { slots: [SLOT, "2026-10-15T11:00:00-04:00"] },
      "2026-10-16": { slots: ["2026-10-16T09:00:00-04:00"] },
      traceId: "trace-1",
    },
  },
  "POST /contacts/upsert": { body: { new: true, contact: { id: "contact-1" } } },
  "PUT /contacts/contact-1": { body: { succeeded: true, contact: { id: "contact-1" } } },
  "POST /contacts/contact-1/tags": { status: 201, body: { tags: [] } },
  "POST /contacts/contact-1/notes": { status: 201, body: { note: { id: "note-1" } } },
  "POST /calendars/events/appointments": { body: { id: "appt-1", calendarId: "cal1" } },
};

function deps(routes: FakeRoutes = okRoutes): SiteLeadDeps {
  fake = createFakeGhl(routes);
  return {
    db,
    secrets,
    ghl,
    http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
    now: () => CLOCK,
    ipHashKey: Buffer.alloc(32, 7),
    rateLimiter: createRateLimiter(),
  };
}

const paths = () => fake.requests.map((r) => `${r.method} ${r.url.pathname}`);

const slotQuery = (over: Partial<SlotQuery> = {}): SlotQuery => ({
  siteId: "site-live",
  calendarId: "cal1",
  start: "2026-10-15",
  days: "2",
  timezone: "America/New_York",
  visitorIp: "203.0.113.7",
  ...over,
});

const booking = {
  calendarId: "cal1",
  startTime: SLOT,
  timezone: "America/New_York",
  name: "Dana Visitor",
  email: "dana@example.test",
  phone: "+1 555 010 0199",
  message: "First visit",
  page: "/book",
  fax: "",
  elapsedMs: 9_000,
};

const book = (d: SiteLeadDeps, body: unknown, siteId = "site-live") =>
  bookSiteAppointment(d, {
    siteId,
    raw: JSON.stringify(body),
    visitorIp: "203.0.113.7",
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-booking-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  await db
    .insert(organization)
    .values({ id: "agency-a", name: "Agency A", slug: "agency-a", createdAt: new Date() });
  await db.insert(location).values({
    id: "sunrise",
    organizationId: "agency-a",
    ghlLocationId: GHL_LOCATION,
    name: "sunrise",
    tursoDbName: "db-sunrise",
    tursoDbHostname: "db-sunrise.turso.test",
    status: "active",
  });
  await db.insert(site).values([
    { id: "site-live", locationId: "sunrise", status: "deployed", repoFullName: "a/live" },
    { id: "site-draft", locationId: "sunrise", status: "draft" },
  ]);
  await secrets.set(
    ghlSecretRef("agency-a"),
    JSON.stringify({
      accessToken: "agency-token",
      refreshToken: "refresh-token",
      expiresAt: CLOCK + 24 * 3_600_000,
      scopes: "calendars.readonly oauth.write",
      companyId: "company-1",
      installedBy: "user-1",
    }),
  );
  await db.insert(agencyGhlConnection).values({
    organizationId: "agency-a",
    ghlCompanyId: "company-1",
    scopes: "calendars.readonly oauth.write",
    secretRef: ghlSecretRef("agency-a"),
    connectedAt: new Date(CLOCK),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a published site's free times", () => {
  it("reads the calendar's free times in the site's own sub-account, for the days asked", async () => {
    const result = await siteSlots(deps(), slotQuery());
    expect(result).toEqual({
      status: 200,
      body: {
        calendar: { name: "Consultation" },
        timezone: "America/New_York",
        days: [
          { date: "2026-10-15", slots: [SLOT, "2026-10-15T11:00:00-04:00"] },
          { date: "2026-10-16", slots: ["2026-10-16T09:00:00-04:00"] },
        ],
      },
    });
    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "GET /calendars/cal1",
      "GET /calendars/cal1/free-slots",
    ]);
    expect(fake.requests[0]?.body).toMatchObject({ locationId: GHL_LOCATION });
    const slots = fake.requests[2];
    expect(slots?.headers.authorization).toBe(`Bearer location-token-${GHL_LOCATION}`);
    expect(slots?.url.searchParams.get("timezone")).toBe("America/New_York");
    const start = Number(slots?.url.searchParams.get("startDate"));
    const end = Number(slots?.url.searchParams.get("endDate"));
    // A day early so no timezone loses its morning, and never more than GHL's 31 days.
    expect(start).toBe(Date.parse("2026-10-14T00:00:00Z"));
    expect(end - start).toBeLessThan(31 * 86_400_000);
  });

  it("refuses another sub-account's calendar and an inactive one", async () => {
    for (const route of [calendar("ghl-loc-other"), calendar(GHL_LOCATION, false)]) {
      const result = await siteSlots(
        deps({ ...okRoutes, "GET /calendars/cal1": route }),
        slotQuery(),
      );
      expect(result.status).toBe(404);
      expect(paths()).not.toContain("GET /calendars/cal1/free-slots");
    }
    const missing = await siteSlots(
      deps({ ...okRoutes, "GET /calendars/cal1": { status: 404, body: { message: "nope" } } }),
      slotQuery(),
    );
    expect(missing.status).toBe(404);
  });

  it("answers an unpublished or unknown site without asking GHL", async () => {
    for (const siteId of ["site-draft", "site-nope", "../x"]) {
      expect((await siteSlots(deps(), slotQuery({ siteId }))).status).toBe(404);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("refuses a query it can't use before anything else", async () => {
    for (const over of [
      { calendarId: "cal/../1" },
      { calendarId: null },
      { timezone: "Mars/Olympus" },
      { start: "tomorrow" },
      { days: "15" },
      { days: "0" },
      { start: "2028-01-01" },
    ]) {
      expect((await siteSlots(deps(), slotQuery(over))).status).toBe(400);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("limits how often one visitor reads times", async () => {
    const d = deps();
    for (let i = 0; i < 60; i++) expect((await siteSlots(d, slotQuery())).status).toBe(200);
    const result = await siteSlots(d, slotQuery());
    expect(result.status).toBe(429);
  }, 30_000);
});

describe("booking on a published site", () => {
  it("adds the visitor as a lead, then books the time on the calendar for that contact", async () => {
    const result = await book(deps(), booking);
    expect(result).toEqual({ status: 200, body: { ok: true, startTime: SLOT } });
    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "GET /calendars/cal1",
      "GET /calendars/cal1/free-slots",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "PUT /contacts/contact-1",
      "POST /contacts/contact-1/notes",
      "POST /calendars/events/appointments",
    ]);
    const tags = fake.requests.find((r) => r.url.pathname.endsWith("/tags"));
    expect(tags?.body).toEqual({ tags: ["website lead", "website form: booking"] });
    const note = fake.requests.find((r) => r.url.pathname.endsWith("/notes"));
    expect(note?.body).toEqual({
      title: "Website form: booking",
      body: `First visit\n\nPage: /book\nBooked: ${SLOT} (America/New_York)`,
    });
    const appointment = fake.requests.at(-1);
    expect(appointment?.headers.authorization).toBe(`Bearer location-token-${GHL_LOCATION}`);
    // The location is the session's; GHL's slot checks stay on.
    expect(appointment?.body).toEqual({
      locationId: GHL_LOCATION,
      calendarId: "cal1",
      contactId: "contact-1",
      startTime: SLOT,
    });
  });

  it("books nothing and adds no contact for a time the calendar doesn't offer", async () => {
    const result = await book(deps(), { ...booking, startTime: "2026-10-15T13:30:00-04:00" });
    expect(result.status).toBe(409);
    expect(paths()).not.toContain("POST /contacts/upsert");
    expect(paths()).not.toContain("POST /calendars/events/appointments");
  });

  it("says the time can't be booked when GHL's own rules refuse it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await book(
      deps({
        ...okRoutes,
        "POST /calendars/events/appointments": {
          status: 400,
          body: { statusCode: 400, message: "The slot you have selected is no longer available" },
        },
      }),
      booking,
    );
    expect(result).toEqual({
      status: 409,
      body: { error: "That time can't be booked any more. Please choose another." },
    });
  });

  it("never books on another sub-account's calendar", async () => {
    const result = await book(
      deps({ ...okRoutes, "GET /calendars/cal1": calendar("ghl-loc-other") }),
      booking,
    );
    expect(result.status).toBe(404);
    expect(paths()).toEqual(["POST /oauth/location-token", "GET /calendars/cal1"]);
  });

  it("drops a bot quietly and books nothing", async () => {
    for (const trap of [{ fax: "x" }, { elapsedMs: 500 }]) {
      const result = await book(deps(), { ...booking, ...trap });
      expect(result.status).toBe(200);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("refuses what a site may not name, a past time and an unpublished site", async () => {
    expect((await book(deps(), { ...booking, locationId: "ghl-loc-other" })).status).toBe(400);
    expect((await book(deps(), { ...booking, contactId: "contact-9" })).status).toBe(400);
    expect((await book(deps(), { ...booking, calendarId: "../cal" })).status).toBe(400);
    expect((await book(deps(), { ...booking, startTime: "soon" })).status).toBe(400);
    expect((await book(deps(), { ...booking, email: "", phone: "" })).status).toBe(400);
    expect(
      (await book(deps(), { ...booking, startTime: "2026-10-01T10:00:00-04:00" })).status,
    ).toBe(409);
    expect((await book(deps(), booking, "site-draft")).status).toBe(404);
    expect(fake.requests).toHaveLength(0);
  });

  it("limits bookings per visitor", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) expect((await book(d, booking)).status).toBe(200);
    expect((await book(d, booking)).status).toBe(429);
  });
});

describe("the builder's calendar list", () => {
  it("lists the client's active calendars with GHL's booking page for each", async () => {
    const d = deps({
      "GET /calendars/": {
        body: {
          calendars: [
            { id: "cal1", name: "Consultation", calendarType: "event", isActive: true },
            { id: "cal2", name: "Old", calendarType: "event", isActive: false },
            { id: "../x", name: "Bad id", isActive: true },
          ],
        },
      },
    });
    const list = await listCalendars(
      { token: "t", tokenKind: "location", locationId: GHL_LOCATION },
      d.http,
    );
    expect(list).toEqual([
      {
        id: "cal1",
        name: "Consultation",
        type: "event",
        embedUrl: "https://api.leadconnectorhq.com/widget/booking/cal1",
      },
    ]);
    expect(fake.requests[0]?.url.searchParams.get("locationId")).toBe(GHL_LOCATION);
    expect(fake.requests[0]?.url.searchParams.get("showDrafted")).toBe("false");
  });
});
