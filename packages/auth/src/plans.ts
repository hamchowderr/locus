/**
 * Locus's plans: three fixed monthly prices, one per agency. The prices live in Stripe under
 * these lookup keys, so the same code works in test mode and live mode without price ids.
 *
 * The names and limits are placeholders until pricing is validated. Only `clients` is enforced
 * today (when a sub-account would be added); the others are recorded for the features that will
 * meter them. `null` means no limit.
 */
export interface PlanLimits {
  clients: number | null;
  sitesPerMonth: number | null;
  agentActionsPerMonth: number | null;
  seats: number | null;
}

export interface Plan {
  /** Stored lower-case on the subscription row. */
  name: string;
  title: string;
  usdPerMonth: number;
  lookupKey: string;
  limits: PlanLimits;
}

export const PLANS: readonly Plan[] = [
  {
    name: "starter",
    title: "Starter",
    usdPerMonth: 97,
    lookupKey: "locus_starter_monthly",
    limits: { clients: 5, sitesPerMonth: 10, agentActionsPerMonth: 1_000, seats: 1 },
  },
  {
    name: "growth",
    title: "Growth",
    usdPerMonth: 297,
    lookupKey: "locus_growth_monthly",
    limits: { clients: null, sitesPerMonth: 50, agentActionsPerMonth: 10_000, seats: 3 },
  },
  {
    name: "scale",
    title: "Scale",
    usdPerMonth: 497,
    lookupKey: "locus_scale_monthly",
    limits: { clients: null, sitesPerMonth: null, agentActionsPerMonth: 50_000, seats: 10 },
  },
];

export const planNamed = (name: string) => PLANS.find((p) => p.name === name.toLowerCase());
