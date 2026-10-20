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
import { isGhlPayUrl, type SiteCheckoutDeps, startSiteCheckout } from "./site-checkout.ts";

// Level-1 plumbing: the fake GHL plays GoHighLevel. A checkout never reaches an agent from
// this path, so there is nothing for AIMock to play.

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["products.readonly", "oauth.write"],
};

const CLOCK = Date.parse("2026-10-14T12:00:00Z");
const GHL_LOCATION = "ghl-loc-sunrise";
const PAY_URL = "https://link.msgsndr.com/invoice/inv1";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let fake: FakeGhl;

const product = (locationId = GHL_LOCATION) => ({
  body: { _id: "prod1", locationId, name: "Deep  Clean\nPackage", productType: "SERVICE" },
});
const price = (over: Record<string, unknown> = {}) => ({
  body: {
    _id: "price1",
    locationId: GHL_LOCATION,
    product: "prod1",
    name: "Standard",
    type: "one_time",
    currency: "USD",
    amount: 149.5,
    ...over,
  },
});

const okRoutes: FakeRoutes = {
  "POST /oauth/location-token": (req) => ({
    body: {
      access_token: `location-token-${(req.body as { locationId: string }).locationId}`,
      locationId: (req.body as { locationId: string }).locationId,
    },
  }),
  "GET /products/prod1": product(),
  "GET /products/prod1/price/price1": price(),
  "GET /users/search": { body: { users: [{ id: "user1", name: "Owner" }], count: 1 } },
  "POST /contacts/upsert": {
    body: {
      new: false,
      contact: { id: "contact-1", name: "Dana Customer", email: "dana@example.test" },
    },
  },
  "PUT /contacts/contact-1": { body: { succeeded: true, contact: { id: "contact-1" } } },
  "POST /contacts/contact-1/tags": { status: 201, body: { tags: [] } },
  "POST /contacts/contact-1/notes": { status: 201, body: { note: { id: "note-1" } } },
  "POST /invoices/text2pay": {
    body: { invoice: { _id: "inv1", invoiceNumber: 1001, status: "sent" }, invoiceUrl: PAY_URL },
  },
};

function deps(routes: FakeRoutes = okRoutes): SiteCheckoutDeps {
  fake = createFakeGhl(routes);
  return {
    db,
    secrets,
    ghl,
    http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
    now: () => CLOCK,
    ipHashKey: Buffer.alloc(32, 7),
    rateLimiter: createRateLimiter(),
    liveMode: false,
  };
}

const paths = () => fake.requests.map((r) => `${r.method} ${r.url.pathname}`);
const invoiceRequest = () => fake.requests.find((r) => r.url.pathname === "/invoices/text2pay");
const noteBody = () =>
  String(
    (fake.requests.find((r) => r.url.pathname.endsWith("/notes"))?.body as { body?: string })?.body,
  );

const order = {
  productId: "prod1",
  priceId: "price1",
  qty: 2,
  name: "Dana Visitor",
  email: "dana@example.test",
  phone: "+1 555 010 0199",
  page: "/shop",
  fax: "",
  elapsedMs: 9_000,
};

const checkout = (
  d: SiteCheckoutDeps,
  body: unknown,
  siteId = "site-live",
  visitorIp = "203.0.113.7",
) => startSiteCheckout(d, { siteId, raw: JSON.stringify(body), visitorIp });

/** A different visitor each time, for a test that checks out more than one visitor may. */
let visitor = 0;
const nextIp = () => `198.51.100.${++visitor}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-checkout-"));
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
      scopes: "products.readonly oauth.write",
      companyId: "company-1",
      installedBy: "user-1",
    }),
  );
  await db.insert(agencyGhlConnection).values({
    organizationId: "agency-a",
    ghlCompanyId: "company-1",
    scopes: "products.readonly oauth.write",
    secretRef: ghlSecretRef("agency-a"),
    connectedAt: new Date(CLOCK),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("checkout on a published site", () => {
  it("adds the visitor as a lead, has GHL email them an invoice at GHL's price, and answers its payment page", async () => {
    const result = await checkout(deps(), order);
    expect(result).toEqual({ status: 200, body: { ok: true, payUrl: PAY_URL } });
    expect(paths()).toEqual([
      "POST /oauth/location-token",
      "GET /products/prod1",
      "GET /products/prod1/price/price1",
      "GET /users/search",
      "POST /contacts/upsert",
      "POST /contacts/contact-1/tags",
      "PUT /contacts/contact-1",
      "POST /invoices/text2pay",
      "POST /contacts/contact-1/notes",
    ]);
    expect(fake.requests[1]?.url.searchParams.get("locationId")).toBe(GHL_LOCATION);
    expect(fake.requests[2]?.url.searchParams.get("locationId")).toBe(GHL_LOCATION);
    const users = fake.requests[3]?.url.searchParams;
    expect(users?.get("locationId")).toBe(GHL_LOCATION);
    expect(users?.get("companyId")).toBe("company-1");
    const tags = fake.requests.find((r) => r.url.pathname.endsWith("/tags"));
    expect(tags?.body).toEqual({ tags: ["website lead", "website form: checkout"] });

    const invoice = invoiceRequest();
    expect(invoice?.headers.authorization).toBe(`Bearer location-token-${GHL_LOCATION}`);
    // The terms are GHL's; the contact is the one the upsert found, with what it already had.
    expect(invoice?.body).toEqual({
      altId: GHL_LOCATION,
      altType: "location",
      name: "Deep Clean Package",
      currency: "USD",
      items: [
        {
          name: "Deep Clean Package",
          productId: "prod1",
          priceId: "price1",
          currency: "USD",
          amount: 149.5,
          qty: 2,
          type: "one_time",
        },
      ],
      contactDetails: {
        id: "contact-1",
        name: "Dana Customer",
        phoneNo: "+1 555 010 0199",
        email: "dana@example.test",
      },
      issueDate: "2026-10-14",
      dueDate: "2026-10-14",
      sentTo: { email: ["dana@example.test"] },
      liveMode: false,
      action: "send",
      userId: "user1",
    });
    expect(noteBody()).toBe(
      "Also on the form (kept here, not changed on the contact):\nName: Dana Visitor\n\n" +
        "Page: /shop\nStarted checkout: Deep Clean Package × 2 (149.50 USD each), invoice 1001",
    );
  });

  it("takes live payments only when the deployment says so", async () => {
    await checkout({ ...deps(), liveMode: true }, { ...order, liveMode: false });
    expect(invoiceRequest()?.body).toMatchObject({ liveMode: true });
  });

  it("ignores any amount, currency or terms the request names", async () => {
    const result = await checkout(deps(), {
      ...order,
      qty: 1,
      amount: 0.01,
      price: 0.01,
      currency: "JPY",
      total: 0,
      type: "recurring",
    });
    expect(result.status).toBe(200);
    const body = invoiceRequest()?.body as { items: unknown[]; currency: string };
    expect(body.currency).toBe("USD");
    expect(body.items).toEqual([
      expect.objectContaining({ amount: 149.5, qty: 1, currency: "USD" }),
    ]);
    expect(noteBody()).not.toContain("0.01");
    expect(noteBody()).toContain("(149.50 USD), invoice 1001");
  });

  it("never sells another sub-account's product, or a price of another product", async () => {
    for (const routes of [
      { "GET /products/prod1": product("ghl-loc-other") },
      { "GET /products/prod1/price/price1": price({ product: "prod2" }) },
      { "GET /products/prod1/price/price1": price({ locationId: "ghl-loc-other" }) },
      { "GET /products/prod1/price/price1": price({ _id: "price9" }) },
      {
        "GET /products/prod1": {
          status: 400,
          body: { statusCode: 400, message: "Product not found" },
        },
      },
      // Found by its slug: only its own id counts.
      { "GET /products/prod1": { body: { ...product().body, _id: "prod7" } } },
    ]) {
      const result = await checkout(deps({ ...okRoutes, ...routes }), order, "site-live", nextIp());
      expect(result).toEqual({ status: 422, body: { error: "That isn't for sale here." } });
      expect(paths()).not.toContain("POST /contacts/upsert");
      expect(paths()).not.toContain("POST /invoices/text2pay");
    }
  });

  it("refuses a subscription price, a free one, and more than is in stock", async () => {
    const recurring = await checkout(
      deps({
        ...okRoutes,
        "GET /products/prod1/price/price1": price({
          type: "recurring",
          recurring: { interval: "month", intervalCount: 1 },
        }),
      }),
      order,
    );
    expect(recurring).toEqual({
      status: 422,
      body: { error: "That's a subscription, which can't be bought here yet." },
    });
    for (const over of [{ amount: 0 }, { amount: "149.5" }, { currency: "dollars" }]) {
      const result = await checkout(
        deps({ ...okRoutes, "GET /products/prod1/price/price1": price(over) }),
        order,
      );
      expect(result.status).toBe(422);
    }
    const stock = await checkout(
      deps({
        ...okRoutes,
        "GET /products/prod1/price/price1": price({ trackInventory: true, availableQuantity: 1 }),
      }),
      order,
    );
    expect(stock).toEqual({ status: 422, body: { error: "There aren't enough of those left." } });
    expect(paths()).not.toContain("POST /invoices/text2pay");
  });

  it("needs a name, an email and a phone, which GHL's invoice needs", async () => {
    for (const missing of ["name", "email", "phone"]) {
      const result = await checkout(deps(), { ...order, [missing]: "" });
      expect(result).toEqual({
        status: 422,
        body: { error: "Please enter your name, email and phone." },
      });
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("refuses what a site may not name, a quantity out of range and an unpublished site", async () => {
    for (const over of [
      { locationId: "ghl-loc-other" },
      { contactId: "contact-9" },
      { userId: "user9" },
      { productId: "../prod" },
      { priceId: "" },
      { qty: 0 },
      { qty: 11 },
      { qty: 1.5 },
      { qty: "2x" },
    ]) {
      expect((await checkout(deps(), { ...order, ...over })).status).toBe(422);
    }
    expect((await checkout(deps(), order, "site-draft")).status).toBe(404);
    expect((await checkout(deps(), order, "site-nope")).status).toBe(404);
    expect(fake.requests).toHaveLength(0);
    const unread = await startSiteCheckout(deps(), {
      siteId: "site-live",
      raw: "not json",
      visitorIp: null,
    });
    expect(unread.status).toBe(400);
  });

  it("drops a bot quietly and makes nothing", async () => {
    for (const trap of [{ fax: "x" }, { elapsedMs: 500 }, { elapsedMs: undefined }]) {
      const result = await checkout(deps(), { ...order, ...trap });
      expect(result).toEqual({ status: 200, body: { ok: true } });
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("limits checkouts per visitor", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) expect((await checkout(d, order)).status).toBe(200);
    const limited = await checkout(d, order);
    expect(limited.status).toBe(429);
    expect(limited).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it("notes that nothing was charged when GHL won't make the invoice", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkout(
      deps({
        ...okRoutes,
        "POST /invoices/text2pay": { status: 422, body: { statusCode: 422, message: "no" } },
      }),
      order,
    );
    expect(result).toEqual({
      status: 502,
      body: { error: "We couldn't start the checkout just now. Please try again." },
    });
    // The invoice is tried before the note is written, and the note says what happened.
    expect(paths().slice(-2)).toEqual([
      "POST /invoices/text2pay",
      "POST /contacts/contact-1/notes",
    ]);
    expect(noteBody()).toContain(
      "Tried to check out Deep Clean Package × 2 (149.50 USD each), but the invoice couldn't be made. Nothing was charged.",
    );
    expect(noteBody()).not.toContain("Started checkout");
    expect(errors.mock.calls.flat().join(" ")).toContain("invoices.text-2-pay-invoice 422");
  });

  it("makes no contact when the sub-account has no user to invoice as", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkout(
      deps({
        ...okRoutes,
        "GET /users/search": { body: { users: [{ id: "u1", deleted: true }] } },
      }),
      order,
    );
    expect(result).toEqual({
      status: 502,
      body: { error: "Checkout isn't set up for this site yet. Please contact us instead." },
    });
    expect(paths()).not.toContain("POST /contacts/upsert");
    expect(errors.mock.calls.flat().join(" ")).toContain("has no user");
  });

  it("never sends the visitor to a payment page that isn't GHL's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const invoiceUrl of [
      "http://link.msgsndr.com/invoice/inv1",
      "https://evil.test/invoice/inv1",
      "https://link.msgsndr.com.evil.test/x",
      "https://user:pw@link.msgsndr.com/x",
      "javascript:alert(1)",
      undefined,
    ]) {
      const result = await checkout(
        deps({
          ...okRoutes,
          "POST /invoices/text2pay": {
            body: { invoice: { _id: "inv1", invoiceNumber: 7 }, invoiceUrl },
          },
        }),
        order,
        "site-live",
        nextIp(),
      );
      expect(result).toEqual({
        status: 502,
        body: { error: "We couldn't open the payment page. Your invoice is on its way by email." },
      });
      expect(noteBody()).toContain(
        "invoice 7. It was emailed; the site couldn't open its payment page.",
      );
    }
  });

  it("answers a broken GHL connection as an outage", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkout(
      deps({ ...okRoutes, "GET /products/prod1": { status: 401, body: { message: "no" } } }),
      order,
    );
    expect(result.status).toBe(502);
    expect(errors.mock.calls.flat().join(" ")).toContain("products.get-product-by-id 401");
  });
});

describe("a payment page's address", () => {
  it("is one of GHL's own https hosts", () => {
    expect(isGhlPayUrl("https://link.msgsndr.com/invoice/1")).toBe(true);
    expect(isGhlPayUrl("https://app.leadconnectorhq.com/invoice/1")).toBe(true);
    expect(isGhlPayUrl("https://acme.clientclub.net/invoice/1")).toBe(true);
    expect(isGhlPayUrl("https://link.msgsndr.com:8443/invoice/1")).toBe(false);
    expect(isGhlPayUrl("https://notmsgsndr.com/invoice/1")).toBe(false);
    expect(isGhlPayUrl(42)).toBe(false);
  });
});
