import type { ControlDb } from "@locus/db";
import { subscription } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { rolesOf } from "./client-access.ts";
import { isComped } from "./operator.ts";
import { type Plan, type PlanLimits, planNamed } from "./plans.ts";

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
  | "none";

export interface Entitlement {
  /** May add clients and use paid features. */
  entitled: boolean;
  status: BillingStatus;
  plan: Plan | null;
  /** The plan's limits; `null` when comped (no limits). */
  limits: PlanLimits | null;
}

const PAID = new Set(["active", "trialing"]);

/**
 * What the agency may do, from our own database — never a Stripe call in the request path.
 * Comped beats any subscription. A `past_due` agency is not entitled: it can't add clients, but
 * nothing it already has is taken away (its clients' sites serve people who did nothing wrong).
 */
export async function agencyEntitlement(
  db: ControlDb,
  organizationId: string,
): Promise<Entitlement> {
  if (await isComped(db, organizationId)) {
    return { entitled: true, status: "comped", plan: null, limits: null };
  }
  const rows = await db
    .select()
    .from(subscription)
    .where(eq(subscription.referenceId, organizationId));
  const current =
    rows.find((r) => PAID.has(r.status ?? "")) ??
    rows.find((r) => r.status === "past_due" || r.status === "unpaid") ??
    rows.find((r) => r.stripeSubscriptionId);
  if (!current) return { entitled: false, status: "none", plan: null, limits: null };
  const plan = planNamed(current.plan) ?? null;
  const status = (current.status ?? "incomplete") as BillingStatus;
  return {
    entitled: PAID.has(status) && plan !== null,
    status,
    plan,
    limits: plan?.limits ?? null,
  };
}

/** Why the agency may not add one more client, or `null` if it may. */
export function newClientRefusal(entitlement: Entitlement, activeClients: number): string | null {
  if (!entitlement.entitled) {
    return entitlement.status === "past_due" || entitlement.status === "unpaid"
      ? "Your Locus payment is overdue. Update it on the Billing page to add clients."
      : "Choose a Locus plan on the Billing page to add clients.";
  }
  const cap = entitlement.limits?.clients;
  if (cap != null && activeClients >= cap) {
    return `Your ${entitlement.plan?.title ?? ""} plan covers ${cap} clients. Upgrade on the Billing page to add more.`;
  }
  return null;
}
