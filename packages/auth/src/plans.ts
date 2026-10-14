/**
 * The integer unit usage is metered in: one hundredth of a credit. Every credit amount in code
 * and in the database (`usage_event.credits`, `usage_limit.monthly_credit_cap`, the limits below)
 * is in these units, so `5 * CREDIT` is five credits. One credit is $0.01 of provider cost times
 * the markup in `usage.ts`.
 */
export const CREDIT = 100;

/**
 * Locus's plans: three fixed monthly prices, one per agency. The prices live in Stripe under
 * these lookup keys, so the same code works in test mode and live mode without price ids.
 *
 * The names and limits are placeholders until pricing is validated. `clients` is enforced when a
 * sub-account would be added, and the two credit limits before any AI generation (`usage.ts`);
 * the others are recorded for the features that will meter them. `null` means no limit.
 */
export interface PlanLimits {
  clients: number | null;
  sitesPerMonth: number | null;
  agentActionsPerMonth: number | null;
  seats: number | null;
  /** AI generation credits per calendar month (UTC) for the whole agency, in `CREDIT` units. */
  creditsPerMonth: number | null;
  /** Credits any one sub-account may spend in a rolling 5-hour window, in `CREDIT` units. */
  creditsPer5Hours: number | null;
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
    limits: {
      clients: 5,
      sitesPerMonth: 10,
      agentActionsPerMonth: 1_000,
      seats: 1,
      creditsPerMonth: 5_000 * CREDIT,
      creditsPer5Hours: 1_000 * CREDIT,
    },
  },
  {
    name: "growth",
    title: "Growth",
    usdPerMonth: 297,
    lookupKey: "locus_growth_monthly",
    limits: {
      clients: null,
      sitesPerMonth: 50,
      agentActionsPerMonth: 10_000,
      seats: 3,
      creditsPerMonth: 20_000 * CREDIT,
      creditsPer5Hours: 2_000 * CREDIT,
    },
  },
  {
    name: "scale",
    title: "Scale",
    usdPerMonth: 497,
    lookupKey: "locus_scale_monthly",
    limits: {
      clients: null,
      sitesPerMonth: null,
      agentActionsPerMonth: 50_000,
      seats: 10,
      creditsPerMonth: 40_000 * CREDIT,
      creditsPer5Hours: 4_000 * CREDIT,
    },
  },
];

export const planNamed = (name: string) => PLANS.find((p) => p.name === name.toLowerCase());
