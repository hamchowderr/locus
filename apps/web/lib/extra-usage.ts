import {
  billableSubscription,
  createStripe,
  ensureOverageItem,
  findOveragePrice,
  type OverageReport,
  reportOverage,
} from "@locus/auth";
import { locus } from "./locus.ts";

let stripe: ReturnType<typeof createStripe> | undefined;

/** Stripe for extra usage, or null when this deployment has no billing. Server-side only. */
export function extraUsageStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripe ??= createStripe(key);
  return stripe;
}

/**
 * Gets the agency's subscription ready to bill extra usage before it is turned on. Returns a
 * sentence for the person when it can't be, or null when it is ready. An agency on a trial or
 * still choosing a plan gets the item when its usage is first reported.
 */
export async function prepareExtraUsage(organizationId: string): Promise<string | null> {
  const s = extraUsageStripe();
  if (!s) return "Billing isn't set up on this deployment.";
  const price = await findOveragePrice(s);
  if (!price) return "Extra usage isn't set up on this deployment yet.";
  const billed = await billableSubscription(locus().db, organizationId);
  if (billed) await ensureOverageItem(s, billed.subscription, price.id);
  return null;
}

/** Sends waiting extra usage to Stripe: every agency's, or one agency's. Never throws. */
export async function sendExtraUsage(
  opts: { organizationId?: string; deadline?: Date } = {},
): Promise<OverageReport | null> {
  const s = extraUsageStripe();
  if (!s) return null;
  try {
    return await reportOverage(locus().db, s, opts);
  } catch (error) {
    console.error("[locus] sending extra usage to Stripe failed:", error);
    return null;
  }
}
