import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { organization, subscription, usageEvent } from "@locus/db/control";
import { eq, isNotNull, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OVERAGE_METER_EVENT,
  OVERAGE_PRICE_LOOKUP_KEY,
  reportOverage,
  setupOverageBilling,
} from "./overage-billing.ts";

const NOW = new Date("2026-10-20T12:00:00Z");

/** Just enough of Stripe for extra usage, recording every call. */
function fakeStripe(
  opts: { price?: boolean; failFor?: string; alreadyHas?: string; onSend?: () => void } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  const meters: Stripe.Billing.Meter[] = [];
  const prices: Stripe.Price[] = opts.price === false ? [] : [priceObject("price_extra")];
  const items = new Map<string, string[]>([["sub_a", ["price_plan"]]]);
  const stripe = {
    prices: {
      list: async (params: Stripe.PriceListParams) => {
        calls.push({ method: "prices.list", params });
        return { data: prices.filter((p) => params.lookup_keys?.includes(p.lookup_key ?? "")) };
      },
      create: async (params: Stripe.PriceCreateParams) => {
        calls.push({ method: "prices.create", params });
        const p = priceObject(`price_${prices.length + 1}`);
        prices.push(p);
        return p;
      },
    },
    billing: {
      meters: {
        list: (params: unknown) => {
          calls.push({ method: "meters.list", params });
          return meters.values();
        },
        create: async (params: Stripe.Billing.MeterCreateParams) => {
          calls.push({ method: "meters.create", params });
          const m = { id: `meter_${meters.length + 1}`, event_name: params.event_name };
          meters.push(m as Stripe.Billing.Meter);
          return m;
        },
      },
      meterEvents: {
        create: async (params: Stripe.Billing.MeterEventCreateParams) => {
          opts.onSend?.();
          if (params.payload.stripe_customer_id === opts.failFor) throw new Error("Stripe is down");
          if (params.identifier === opts.alreadyHas) {
            // Stripe's own wording, seen in test mode.
            throw new Error(`An event already exists with identifier ${params.identifier}.`);
          }
          calls.push({ method: "meterEvents.create", params });
          return {};
        },
      },
    },
    subscriptionItems: {
      list: async ({ subscription: id }: { subscription: string }) => ({
        data: (items.get(id) ?? []).map((price) => ({ price: { id: price } })),
      }),
      create: async (params: { subscription: string; price: string }) => {
        calls.push({ method: "subscriptionItems.create", params });
        items.set(params.subscription, [...(items.get(params.subscription) ?? []), params.price]);
        return {};
      },
    },
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

function priceObject(id: string) {
  return { id, lookup_key: OVERAGE_PRICE_LOOKUP_KEY } as Stripe.Price;
}

let dir: string;
let db: ControlDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-overage-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  for (const id of ["agency-a", "agency-b", "agency-c"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: NOW });
  }
  await db.insert(subscription).values([
    {
      id: "s-a",
      plan: "starter",
      referenceId: "agency-a",
      status: "active",
      stripeCustomerId: "cus_a",
      stripeSubscriptionId: "sub_a",
    },
    {
      id: "s-b",
      plan: "starter",
      referenceId: "agency-b",
      status: "past_due",
      stripeCustomerId: "cus_b",
      stripeSubscriptionId: "sub_b",
    },
    // Cancelled: nothing to bill extra usage to.
    {
      id: "s-c",
      plan: "starter",
      referenceId: "agency-c",
      status: "canceled",
      stripeCustomerId: "cus_c",
      stripeSubscriptionId: "sub_c",
    },
  ]);
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;

async function event(id: string, organizationId: string, overageCredits: number, minute = 0) {
  await db.insert(usageEvent).values({
    id,
    organizationId,
    locationId: `${organizationId}-1`,
    kind: "sandbox",
    credits: overageCredits + 100,
    overageCredits,
    createdAt: new Date(NOW.getTime() - 3_600_000 + minute * 60_000 + seq++),
  });
}

const sent = (calls: { method: string; params: unknown }[]) =>
  calls.filter((c) => c.method === "meterEvents.create").map((c) => c.params);

describe("reportOverage", () => {
  it("sends each agency's extra usage to the meter once, and adds the metered item", async () => {
    const { stripe, calls } = fakeStripe();
    await event("e1", "agency-a", 1_500);
    await event("e2", "agency-a", 250, 1);
    await event("e3", "agency-b", 40);
    await event("plain", "agency-a", 0);

    expect(await reportOverage(db, stripe, { now: NOW })).toEqual({ reported: 3, pending: 0 });
    expect(sent(calls)).toEqual([
      {
        event_name: OVERAGE_METER_EVENT,
        identifier: "e1",
        timestamp: NOW.getTime() / 1000,
        payload: { stripe_customer_id: "cus_a", value: "1500" },
      },
      expect.objectContaining({
        identifier: "e2",
        payload: expect.objectContaining({ value: "250" }),
      }),
      expect.objectContaining({
        identifier: "e3",
        payload: expect.objectContaining({ stripe_customer_id: "cus_b" }),
      }),
    ]);
    // Neither subscription had the metered item yet; each gets it once.
    expect(calls.filter((c) => c.method === "subscriptionItems.create")).toEqual([
      {
        method: "subscriptionItems.create",
        params: expect.objectContaining({ subscription: "sub_a", price: "price_extra" }),
      },
      {
        method: "subscriptionItems.create",
        params: expect.objectContaining({ subscription: "sub_b", price: "price_extra" }),
      },
    ]);

    // Everything is marked; a second run sends nothing and adds no item.
    const again = fakeStripe();
    expect(await reportOverage(db, again.stripe, { now: NOW })).toEqual({
      reported: 0,
      pending: 0,
    });
    expect(again.calls).toEqual([]);
  });

  it("keeps usage waiting when Stripe has no metered price yet", async () => {
    const { stripe, calls } = fakeStripe({ price: false });
    await event("e1", "agency-a", 1_500);
    expect(await reportOverage(db, stripe, { now: NOW })).toEqual({ reported: 0, pending: 1 });
    expect(sent(calls)).toEqual([]);
  });

  it("keeps an agency's usage waiting when Stripe fails, and goes on with the others", async () => {
    const { stripe, calls } = fakeStripe({ failFor: "cus_a" });
    await event("e1", "agency-a", 1_500);
    await event("e2", "agency-b", 40, 1);
    await event("e3", "agency-c", 70, 2);
    expect(await reportOverage(db, stripe, { now: NOW })).toEqual({ reported: 1, pending: 2 });
    expect(sent(calls)).toEqual([expect.objectContaining({ identifier: "e2" })]);
    const waiting = await db
      .select({ id: usageEvent.id })
      .from(usageEvent)
      .where(isNull(usageEvent.overageReportedAt));
    expect(waiting.map((w) => w.id).sort()).toEqual(["e1", "e3"]);
  });

  it("marks an event Stripe already has as sent, and goes on", async () => {
    const { stripe, calls } = fakeStripe({ alreadyHas: "e1" });
    await event("e1", "agency-a", 1_500);
    await event("e2", "agency-a", 250, 1);
    expect(await reportOverage(db, stripe, { now: NOW })).toEqual({ reported: 2, pending: 0 });
    expect(sent(calls)).toEqual([expect.objectContaining({ identifier: "e2" })]);
  });

  it("never lets an agency it can't bill hold up the others, however much it has waiting", async () => {
    const { stripe, calls } = fakeStripe();
    // agency-c's plan was cancelled: its usage waits, and there is a lot of it, oldest first.
    const rows = (prefix: string, organizationId: string, from: number) =>
      Array.from({ length: 450 }, (_, i) => ({
        id: `${prefix}${i}`,
        organizationId,
        locationId: `${organizationId}-1`,
        kind: "sandbox" as const,
        credits: 110,
        overageCredits: 10,
        createdAt: new Date(from + i),
      }));
    await db.insert(usageEvent).values(rows("c", "agency-c", NOW.getTime() - 7_200_000));
    await db.insert(usageEvent).values(rows("a", "agency-a", NOW.getTime() - 3_600_000));
    expect(await reportOverage(db, stripe, { now: NOW })).toEqual({ reported: 450, pending: 450 });
    expect(sent(calls)).toHaveLength(450);
  });

  it("bills the agency's current subscription, not an old overdue one", async () => {
    await db.insert(subscription).values({
      id: "s-a-old",
      plan: "starter",
      referenceId: "agency-a",
      status: "unpaid",
      stripeCustomerId: "cus_a",
      stripeSubscriptionId: "sub_old",
    });
    // The old row is listed first: the current one is written again after it.
    const [current] = await db.select().from(subscription).where(eq(subscription.id, "s-a"));
    await db.delete(subscription).where(eq(subscription.id, "s-a"));
    if (current) await db.insert(subscription).values(current);
    const { stripe, calls } = fakeStripe();
    await event("e1", "agency-a", 1_500);
    await reportOverage(db, stripe, { now: NOW });
    expect(calls.filter((c) => c.method === "subscriptionItems.create")).toEqual([
      {
        method: "subscriptionItems.create",
        params: expect.objectContaining({ subscription: "sub_a" }),
      },
    ]);
  });

  it("stops starting new pages once the deadline passes", async () => {
    const { stripe, calls } = fakeStripe();
    await event("e1", "agency-a", 1_500);
    const past = new Date(Date.now() - 1);
    expect(await reportOverage(db, stripe, { now: NOW, deadline: past })).toEqual({
      reported: 0,
      pending: 1,
    });
    expect(sent(calls)).toEqual([]);
  });

  it("stops at the deadline mid-page, with everything it sent marked", async () => {
    for (let i = 0; i < 6; i++) await event(`e${i}`, "agency-a", 10, i);
    // Each send takes 100 ms of a fake clock; the deadline allows three.
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { stripe, calls } = fakeStripe({ onSend: () => (clock += 100) });
    try {
      const r = await reportOverage(db, stripe, { now: NOW, deadline: new Date(1_250) });
      expect(r).toEqual({ reported: 3, pending: 3 });
    } finally {
      now.mockRestore();
    }
    const marked = await db
      .select({ id: usageEvent.id })
      .from(usageEvent)
      .where(isNotNull(usageEvent.overageReportedAt));
    expect(marked.map((m) => m.id).sort()).toEqual(["e0", "e1", "e2"]);
    expect(sent(calls)).toHaveLength(3);
  });

  it("reports one agency only when asked to", async () => {
    const { stripe, calls } = fakeStripe();
    await event("e1", "agency-a", 1_500);
    await event("e2", "agency-b", 40);
    await reportOverage(db, stripe, { now: NOW, organizationId: "agency-b" });
    expect(sent(calls)).toEqual([expect.objectContaining({ identifier: "e2" })]);
  });
});

describe("setupOverageBilling", () => {
  it("creates the meter and the whole-credit metered price once", async () => {
    const { stripe, calls } = fakeStripe({ price: false });
    const first = await setupOverageBilling(stripe);
    expect(first.created).toEqual(["meter meter_1", "price price_1"]);
    expect(calls.find((c) => c.method === "prices.create")?.params).toMatchObject({
      lookup_key: OVERAGE_PRICE_LOOKUP_KEY,
      unit_amount: 1,
      transform_quantity: { divide_by: 100, round: "up" },
      recurring: { interval: "month", usage_type: "metered", meter: "meter_1" },
    });
    const second = await setupOverageBilling(stripe);
    expect(second.created).toEqual([]);
    expect(second.price.id).toBe("price_1");
  });
});
