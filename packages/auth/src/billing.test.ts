import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import * as schema from "@locus/db/control";
import { agencyComp, organization, subscription, user } from "@locus/db/control";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import { agencyEntitlement, mayManageBilling, newClientRefusal } from "./billing.ts";

const WEBHOOK_SECRET = "whsec_test_locus_billing";

let dir: string;
let db: ControlDb;
let auth: ReturnType<typeof createAuth>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-billing-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  auth = createAuth({
    db,
    schema,
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-0000",
    sendEmail: async () => {},
    billing: { secretKey: "sk_test_never_called", webhookSecret: WEBHOOK_SECRET },
  });
  await db.insert(organization).values({
    id: "agency-a",
    name: "Agency A",
    slug: "agency-a",
    createdAt: new Date(),
    stripeCustomerId: "cus_agency_a",
  });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** A Stripe subscription event, as Stripe would send it, for one of the plans' prices. */
function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated",
  status: string,
  lookupKey = "locus_starter_monthly",
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `evt_${type}_${status}`,
    object: "event",
    type,
    data: {
      object: {
        id: "sub_agency_a",
        object: "subscription",
        customer: "cus_agency_a",
        status,
        metadata: {},
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
        ended_at: null,
        trial_start: null,
        trial_end: null,
        items: {
          data: [
            {
              id: "si_1",
              quantity: 1,
              current_period_start: now,
              current_period_end: now + 30 * 86_400,
              price: { id: "price_x", lookup_key: lookupKey, recurring: { interval: "month" } },
            },
          ],
        },
      },
    },
  };
}

async function deliver(event: unknown, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const signature = new Stripe("sk_test_unused").webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return auth.handler(
    new Request("http://localhost:3000/api/auth/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      body: payload,
    }),
  );
}

describe("who may manage billing", () => {
  it("owners and admins of the session's own agency, nobody else", () => {
    expect(mayManageBilling({ role: "owner" }, "agency-a", "agency-a")).toBe(true);
    expect(mayManageBilling({ role: "member,admin" }, "agency-a", "agency-a")).toBe(true);
    expect(mayManageBilling({ role: "member" }, "agency-a", "agency-a")).toBe(false);
    expect(mayManageBilling(null, "agency-a", "agency-a")).toBe(false);
    // An agency id the caller picked, not the session's: refused even for an owner.
    expect(mayManageBilling({ role: "owner" }, "agency-a", "agency-b")).toBe(false);
    expect(mayManageBilling({ role: "owner" }, null, "agency-a")).toBe(false);
  });
});

describe("entitlement, from our own database", () => {
  it("is nothing until the agency subscribes or is comped", async () => {
    const none = await agencyEntitlement(db, "agency-a");
    expect(none).toMatchObject({ entitled: false, status: "none" });
    expect(newClientRefusal(none, 0)).toMatch(/Choose a Locus plan/);
  });

  it("comped beats everything and has no limits", async () => {
    await db
      .insert(user)
      .values({ id: "ops", name: "ops", email: "ops@x.test", emailVerified: true });
    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    const comped = await agencyEntitlement(db, "agency-a");
    expect(comped).toMatchObject({ entitled: true, status: "comped", limits: null });
    expect(newClientRefusal(comped, 10_000)).toBeNull();
  });

  it("follows Stripe's webhook: subscribed, then overdue", async () => {
    const created = await deliver(subscriptionEvent("customer.subscription.created", "active"));
    expect(created.status).toBe(200);
    const active = await agencyEntitlement(db, "agency-a");
    expect(active).toMatchObject({ entitled: true, status: "active" });
    expect(active.plan?.name).toBe("starter");
    // Starter's placeholder cap is 5 clients.
    expect(newClientRefusal(active, 4)).toBeNull();
    expect(newClientRefusal(active, 5)).toMatch(/covers 5 clients/);

    await deliver(subscriptionEvent("customer.subscription.updated", "past_due"));
    const overdue = await agencyEntitlement(db, "agency-a");
    expect(overdue).toMatchObject({ entitled: false, status: "past_due" });
    expect(newClientRefusal(overdue, 0)).toMatch(/overdue/);
  });

  it("an unlimited plan never caps clients", async () => {
    await deliver(
      subscriptionEvent("customer.subscription.created", "active", "locus_growth_monthly"),
    );
    const growth = await agencyEntitlement(db, "agency-a");
    expect(growth.plan?.name).toBe("growth");
    expect(newClientRefusal(growth, 500)).toBeNull();
  });

  it("refuses an event that Stripe didn't sign, and records nothing", async () => {
    const forged = await deliver(
      subscriptionEvent("customer.subscription.created", "active"),
      "whsec_someone_else",
    );
    expect(forged.status).toBe(400);
    expect(await db.select().from(subscription)).toEqual([]);
  });

  it("without billing configured, the webhook refuses everything", async () => {
    auth = createAuth({
      db,
      schema,
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-0000",
      sendEmail: async () => {},
    });
    const res = await deliver(subscriptionEvent("customer.subscription.created", "active"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      await db.select().from(subscription).where(eq(subscription.referenceId, "agency-a")),
    ).toEqual([]);
  });
});
