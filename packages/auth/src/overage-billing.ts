import type { ControlDb } from "@locus/db";
import { subscription, usageEvent } from "@locus/db/control";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import Stripe from "stripe";

/**
 * Billing an agency's extra usage (`usage.ts`) through Stripe's usage-based billing: one Billing
 * Meter that sums extra credits per customer, and one metered monthly price on it, added as a
 * second item on the agency's plan subscription. Stripe adds the period's total to the invoice.
 *
 * Both are found by name (the meter's event name, the price's lookup key), like the plans, so the
 * same code works in test and live mode; `setupOverageBilling` creates them once per Stripe
 * account. Nothing here is called in a generation's request path: `recordUsage` only marks the
 * overage in our database, and `reportOverage` sends it later.
 */

export const OVERAGE_METER_EVENT = "locus_ai_credits";
export const OVERAGE_PRICE_LOOKUP_KEY = "locus_ai_credits_overage";
/** What an extra credit costs the agency, in US cents. A placeholder until pricing is validated. */
export const OVERAGE_CENTS_PER_CREDIT = 1;
/** Meter values are in `CREDIT` units (hundredths of a credit); the price bills whole credits. */
const UNITS_PER_CREDIT = 100;

/** A Stripe client for the jobs here, so apps don't each pin their own `stripe` package. */
export const createStripe = (secretKey: string): Stripe => new Stripe(secretKey);

/** The metered price, or null when this Stripe account isn't set up for extra usage. */
export async function findOveragePrice(stripe: Stripe): Promise<Stripe.Price | null> {
  const { data } = await stripe.prices.list({
    lookup_keys: [OVERAGE_PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  return data[0] ?? null;
}

/**
 * Creates the meter and the metered price if this Stripe account has neither. Safe to run again:
 * it finds what an earlier run made. For a one-off setup script, never the request path.
 */
export async function setupOverageBilling(
  stripe: Stripe,
): Promise<{ meter: Stripe.Billing.Meter; price: Stripe.Price; created: string[] }> {
  const created: string[] = [];
  let meter: Stripe.Billing.Meter | undefined;
  for await (const m of stripe.billing.meters.list({ status: "active", limit: 100 })) {
    if (m.event_name === OVERAGE_METER_EVENT) {
      meter = m;
      break;
    }
  }
  if (!meter) {
    meter = await stripe.billing.meters.create({
      display_name: "Locus extra AI credits",
      event_name: OVERAGE_METER_EVENT,
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
    created.push(`meter ${meter.id}`);
  }
  let price = await findOveragePrice(stripe);
  if (!price) {
    price = await stripe.prices.create({
      currency: "usd",
      lookup_key: OVERAGE_PRICE_LOOKUP_KEY,
      product_data: { name: "Extra AI credits" },
      unit_amount: OVERAGE_CENTS_PER_CREDIT,
      // Usage arrives in hundredths of a credit; the invoice shows whole credits, rounded up.
      transform_quantity: { divide_by: UNITS_PER_CREDIT, round: "up" },
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    });
    created.push(`price ${price.id}`);
  }
  return { meter, price, created };
}

/**
 * Adds the metered price to a subscription that lacks it. A plan change through the Stripe
 * plugin keeps items it doesn't know about, so this stays on across upgrades. No proration: the
 * item costs nothing until there is usage.
 */
export async function ensureOverageItem(
  stripe: Stripe,
  stripeSubscriptionId: string,
  priceId: string,
): Promise<void> {
  const { data } = await stripe.subscriptionItems.list({
    subscription: stripeSubscriptionId,
    limit: 100,
  });
  if (data.some((item) => item.price.id === priceId)) return;
  await stripe.subscriptionItems.create({
    subscription: stripeSubscriptionId,
    price: priceId,
    proration_behavior: "none",
  });
}

/** Stripe's answer to a meter event whose identifier it already has. */
function alreadySent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /already exists with identifier/i.test(message);
}

/** Subscriptions that still invoice: extra usage is billed on them. */
const BILLABLE = ["active", "trialing", "past_due", "unpaid"];

/** The agency's Stripe customer and subscription that extra usage is billed to, if any. */
export async function billableSubscription(db: ControlDb, organizationId: string) {
  const rows = await db
    .select({
      customer: subscription.stripeCustomerId,
      subscription: subscription.stripeSubscriptionId,
    })
    .from(subscription)
    .where(
      and(eq(subscription.referenceId, organizationId), inArray(subscription.status, BILLABLE)),
    );
  const row = rows.find((r) => r.customer && r.subscription);
  return row?.customer && row.subscription
    ? { customer: row.customer, subscription: row.subscription }
    : null;
}

export interface OverageReport {
  /** Events sent to Stripe's meter. */
  reported: number;
  /** Events left to send next time: no billable subscription, no price yet, or Stripe failed. */
  pending: number;
}

/**
 * Sends extra usage that is not yet on Stripe's meter, oldest first, and marks it sent. Each
 * meter event carries the usage event's id as its identifier, so Stripe drops one it already has
 * if two runs overlap. Usage is stamped with the time it is sent, not when it happened, so usage
 * sent late lands on the open invoice instead of a closed one.
 *
 * Errors from Stripe leave the agency's remaining events for the next run; other agencies go on.
 */
export async function reportOverage(
  db: ControlDb,
  stripe: Stripe,
  opts: { organizationId?: string; now?: Date; max?: number } = {},
): Promise<OverageReport> {
  const now = opts.now ?? new Date();
  const events = await db
    .select({
      id: usageEvent.id,
      organizationId: usageEvent.organizationId,
      overageCredits: usageEvent.overageCredits,
    })
    .from(usageEvent)
    .where(
      and(
        gt(usageEvent.overageCredits, 0),
        isNull(usageEvent.overageReportedAt),
        opts.organizationId ? eq(usageEvent.organizationId, opts.organizationId) : undefined,
      ),
    )
    .orderBy(asc(usageEvent.createdAt))
    .limit(opts.max ?? 500);
  if (events.length === 0) return { reported: 0, pending: 0 };

  const price = await findOveragePrice(stripe);
  if (!price) {
    console.error(
      "[locus] extra usage is waiting: Stripe has no price %s",
      OVERAGE_PRICE_LOOKUP_KEY,
    );
    return { reported: 0, pending: events.length };
  }

  const byAgency = new Map<string, typeof events>();
  for (const e of events)
    byAgency.set(e.organizationId, [...(byAgency.get(e.organizationId) ?? []), e]);
  let reported = 0;
  for (const [organizationId, agencyEvents] of byAgency) {
    const billed = await billableSubscription(db, organizationId);
    if (!billed) continue;
    try {
      await ensureOverageItem(stripe, billed.subscription, price.id);
      for (const e of agencyEvents) {
        await stripe.billing.meterEvents
          .create({
            event_name: OVERAGE_METER_EVENT,
            identifier: e.id,
            timestamp: Math.floor(now.getTime() / 1000),
            payload: { stripe_customer_id: billed.customer, value: String(e.overageCredits) },
          })
          .catch((error: unknown) => {
            // An overlapping run already sent it: Stripe has it, so it only needs marking.
            if (!alreadySent(error)) throw error;
          });
        await db.update(usageEvent).set({ overageReportedAt: now }).where(eq(usageEvent.id, e.id));
        reported += 1;
      }
    } catch (error) {
      console.error("[locus] extra usage for agency %s not sent to Stripe:", organizationId, error);
    }
  }
  return { reported, pending: events.length - reported };
}
