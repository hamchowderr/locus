import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import * as schema from "@locus/db/control";
import { agencyComp, agencyTrial, organization, subscription, user } from "@locus/db/control";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import {
  agencyEntitlement,
  mayManageBilling,
  newClientRefusal,
  startTrial,
  TRIAL_DAYS,
  trialDaysLeft,
} from "./billing.ts";

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

describe("the free trial", () => {
  const start = new Date("2026-10-26T12:00:00Z");
  const later = (days: number) => new Date(start.getTime() + days * 86_400_000);

  it("gives a new agency Starter's limits for three days, with no card", async () => {
    expect(await startTrial(db, "agency-a", "owner-1", { now: start })).toBe(true);
    const trial = await agencyEntitlement(db, "agency-a", { now: later(1) });
    expect(trial).toMatchObject({ entitled: true, status: "trialing" });
    expect(trial.plan?.name).toBe("starter");
    expect(trial.trialEndsAt).toEqual(later(TRIAL_DAYS));
    expect(newClientRefusal(trial, 4)).toBeNull();
    expect(newClientRefusal(trial, 5)).toMatch(/covers 5 clients/);
    expect(trialDaysLeft(trial.trialEndsAt as Date, later(1))).toBe(2);
    expect(trialDaysLeft(trial.trialEndsAt as Date, later(2.9))).toBe(1);
  });

  it("ends after three days, and says so", async () => {
    await startTrial(db, "agency-a", "owner-1", { now: start });
    const ended = await agencyEntitlement(db, "agency-a", { now: later(TRIAL_DAYS) });
    expect(ended).toMatchObject({ entitled: false, status: "trial_ended", plan: null });
    expect(newClientRefusal(ended, 0)).toMatch(/free trial has ended/);
  });

  it("is once per person, and once per agency", async () => {
    expect(await startTrial(db, "agency-a", "owner-1", { now: start })).toBe(true);
    // The same person's second agency gets no trial.
    expect(await startTrial(db, "agency-b", "owner-1", { now: start })).toBe(false);
    // Nor does the same agency start a second one.
    expect(await startTrial(db, "agency-a", "owner-2", { now: later(5) })).toBe(false);
    const rows = await db.select().from(agencyTrial);
    expect(rows).toHaveLength(1);
    expect(await agencyEntitlement(db, "agency-b")).toMatchObject({ status: "none" });
  });

  it("gives way to a paid plan, during the trial or after it", async () => {
    await startTrial(db, "agency-a", "owner-1", { now: start });
    await deliver(
      subscriptionEvent("customer.subscription.created", "active", "locus_growth_monthly"),
    );
    for (const now of [later(1), later(10)]) {
      const paid = await agencyEntitlement(db, "agency-a", { now });
      expect(paid).toMatchObject({ entitled: true, status: "active", trialEndsAt: null });
      expect(paid.plan?.name).toBe("growth");
    }
  });

  it("a running trial still counts beside an unfinished checkout", async () => {
    await startTrial(db, "agency-a", "owner-1", { now: start });
    await deliver(subscriptionEvent("customer.subscription.created", "incomplete"));
    const trial = await agencyEntitlement(db, "agency-a", { now: later(1) });
    expect(trial).toMatchObject({ entitled: true, status: "trialing" });
  });

  it("an overdue payment after the trial shows as overdue, not as an ended trial", async () => {
    await startTrial(db, "agency-a", "owner-1", { now: start });
    await deliver(subscriptionEvent("customer.subscription.created", "active"));
    await deliver(subscriptionEvent("customer.subscription.updated", "past_due"));
    const overdue = await agencyEntitlement(db, "agency-a", { now: later(10) });
    expect(overdue).toMatchObject({ entitled: false, status: "past_due" });
  });
});

describe("adding waiting sub-accounts once paid", () => {
  it("tells the web app when Stripe says the agency is paid up, and not otherwise", async () => {
    const paid: string[] = [];
    auth = createAuth({
      db,
      schema,
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-0000",
      sendEmail: async () => {},
      billing: { secretKey: "sk_test_never_called", webhookSecret: WEBHOOK_SECRET },
      onAgencyPaid: async (organizationId) => {
        paid.push(organizationId);
      },
    });
    await deliver(subscriptionEvent("customer.subscription.created", "incomplete"));
    expect(paid).toEqual([]);
    await deliver(subscriptionEvent("customer.subscription.updated", "active"));
    expect(paid).toEqual(["agency-a"]);
    await deliver(subscriptionEvent("customer.subscription.updated", "past_due"));
    expect(paid).toEqual(["agency-a"]);
    await deliver(subscriptionEvent("customer.subscription.updated", "active"));
    expect(paid).toEqual(["agency-a", "agency-a"]);
    // A renewal changes the period, not the status or the plan: nothing to add.
    const renewal = subscriptionEvent("customer.subscription.updated", "active");
    await deliver({
      ...renewal,
      id: "evt_renewal",
      data: { ...renewal.data, previous_attributes: { latest_invoice: "in_old" } },
    });
    expect(paid).toEqual(["agency-a", "agency-a"]);
  });

  it("a failure there never fails Stripe's webhook", async () => {
    auth = createAuth({
      db,
      schema,
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-0000",
      sendEmail: async () => {},
      billing: { secretKey: "sk_test_never_called", webhookSecret: WEBHOOK_SECRET },
      onAgencyPaid: async () => {
        throw new Error("GoHighLevel is down");
      },
    });
    const res = await deliver(subscriptionEvent("customer.subscription.created", "active"));
    expect(res.status).toBe(200);
  });
});
