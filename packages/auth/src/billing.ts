import type { ControlDb } from "@locus/db";
import { agencyTrial, subscription } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { rolesOf } from "./client-access.ts";
import { isComped } from "./operator.ts";
import { type Plan, type PlanLimits, planNamed, TRIAL_PLAN } from "./plans.ts";

/** How long the free trial lasts. No card is asked for to start it. */
export const TRIAL_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * Whether a member may manage the agency's billing: the agency must be the session's active
 * one (never an id the caller picked) and the member one of its owners or admins.
 */
export function mayManageBilling(
  membership: { role: string } | null | undefined,
  activeOrganizationId: string | null | undefined,
  referenceId: string,
): boolean {
  if (!membership || !activeOrganizationId || referenceId !== activeOrganizationId) return false;
  return rolesOf(membership.role).some((r) => r === "owner" || r === "admin");
}

export type BillingStatus =
  | "comped"
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  /** The free trial (`agency_trial`) is over and no plan was chosen. */
  | "trial_ended"
  | "none";

export interface Entitlement {
  /** May add clients and use paid features. */
  entitled: boolean;
  status: BillingStatus;
  plan: Plan | null;
  /** The plan's limits; `null` when comped (no limits). */
  limits: PlanLimits | null;
  /**
   * When the agency's free trial ends (or ended). Set only while the free trial is what the
   * agency is on, or after it ended with nothing else; a Stripe subscription takes over from it.
   */
  trialEndsAt: Date | null;
}

const PAID = new Set(["active", "trialing"]);

/**
 * What the agency may do, from our own database — never a Stripe call in the request path.
 * Comped beats any subscription, and a paid subscription beats the free trial. A `past_due`
 * agency is not entitled: it can't add clients, but nothing it already has is taken away (its
 * clients' sites serve people who did nothing wrong).
 */
export async function agencyEntitlement(
  db: ControlDb,
  organizationId: string,
  opts: { now?: Date } = {},
): Promise<Entitlement> {
  if (await isComped(db, organizationId)) {
    return { entitled: true, status: "comped", plan: null, limits: null, trialEndsAt: null };
  }
  const rows = await db
    .select()
    .from(subscription)
    .where(eq(subscription.referenceId, organizationId));
  const paid = rows.find((r) => PAID.has(r.status ?? ""));
  if (paid) return fromSubscription(paid);

  const [trial] = await db
    .select()
    .from(agencyTrial)
    .where(eq(agencyTrial.organizationId, organizationId));
  const now = opts.now ?? new Date();
  if (trial && trial.endsAt > now) {
    return {
      entitled: true,
      status: "trialing",
      plan: TRIAL_PLAN,
      limits: TRIAL_PLAN.limits,
      trialEndsAt: trial.endsAt,
    };
  }

  const current =
    rows.find((r) => r.status === "past_due" || r.status === "unpaid") ??
    rows.find((r) => r.stripeSubscriptionId);
  if (current) return fromSubscription(current);
  if (trial) {
    return {
      entitled: false,
      status: "trial_ended",
      plan: null,
      limits: null,
      trialEndsAt: trial.endsAt,
    };
  }
  return { entitled: false, status: "none", plan: null, limits: null, trialEndsAt: null };
}

function fromSubscription(row: typeof subscription.$inferSelect): Entitlement {
  const plan = planNamed(row.plan) ?? null;
  const status = (row.status ?? "incomplete") as BillingStatus;
  return {
    entitled: PAID.has(status) && plan !== null,
    status,
    plan,
    limits: plan?.limits ?? null,
    trialEndsAt: null,
  };
}

/**
 * Starts the agency's free trial, unless the person starting it already had one (for this or
 * another agency) or the agency already has one. Returns whether a trial started.
 */
export async function startTrial(
  db: ControlDb,
  organizationId: string,
  userId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const started = await db
    .insert(agencyTrial)
    .values({
      organizationId,
      startedByUserId: userId,
      startedAt: now,
      endsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS),
    })
    .onConflictDoNothing()
    .returning({ organizationId: agencyTrial.organizationId });
  return started.length > 0;
}

/** Whole days left in a trial, rounded up: a trial with an hour left has 1 day left. */
export function trialDaysLeft(endsAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));
}

/** Why the agency may not add one more client, or `null` if it may. */
export function newClientRefusal(entitlement: Entitlement, activeClients: number): string | null {
  if (!entitlement.entitled) {
    if (entitlement.status === "past_due" || entitlement.status === "unpaid") {
      return "Your Locus payment is overdue. Update it on the Billing page to add clients.";
    }
    return entitlement.status === "trial_ended"
      ? "Your free trial has ended. Choose a Locus plan on the Billing page to add clients."
      : "Choose a Locus plan on the Billing page to add clients.";
  }
  const cap = entitlement.limits?.clients;
  if (cap != null && activeClients >= cap) {
    return `Your ${entitlement.plan?.title ?? ""} plan covers ${cap} clients. Upgrade on the Billing page to add more.`;
  }
  return null;
}
