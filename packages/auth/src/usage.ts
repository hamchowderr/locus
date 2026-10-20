import { randomUUID } from "node:crypto";
import type { ControlDb } from "@locus/db";
import {
  auditLog,
  location,
  usageAlert,
  usageEvent,
  usageLimit,
  usageMonth,
  usageOverage,
} from "@locus/db/control";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { agencyEntitlement, type Entitlement } from "./billing.ts";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  ClientAccessDenied,
  requireAgencyManager,
  type SessionContext,
} from "./client-access.ts";
import { billableSubscription } from "./overage-billing.ts";
import { CREDIT } from "./plans.ts";

/**
 * Usage metering for AI site generation, per client (one GHL location) and per agency.
 *
 * Units: every credit amount is an integer in hundredths of a credit (`CREDIT = 100`). One credit
 * is `USD_PER_CREDIT` ($0.01) of provider cost times `MARKUP`, so a measurement costing Otaku
 * $0.01 at the provider is 1.5 credits (150 units). Prices round up to the next unit.
 *
 * Periods: the agency's monthly credits and a client's monthly cap run by calendar month in UTC,
 * not the Stripe billing period — comped agencies have no Stripe period, and a calendar month
 * needs no Stripe data in the request path. The burst limit is a rolling 5-hour window per client.
 *
 * Tenancy: the per-client functions take an `AuthorizedClient` (checked with
 * `assertAuthorizedClient`) and read the agency from its location, so a client and an agency
 * that don't belong together can't be passed; agency-wide reads need an owner or admin session.
 * Nothing takes an organisation or location id from a request.
 *
 * Monthly totals are read from `usage_month`, a rollup written in the same batch as each event;
 * only the 5-hour window sums events.
 *
 * Extra usage: an agency that turns it on (`setUsageOverage`) keeps generating past its plan's
 * monthly credits, up to a monthly limit of its own. `recordUsage` marks the part of each event
 * past the plan's credits as `overage_credits`, and `reportOverage` (`overage-billing.ts`) sends
 * it to Stripe's meter, which bills it on the agency's next invoice.
 */

/** Provider cost in USD that one credit stands for, before the markup. */
export const USD_PER_CREDIT = 0.01;
/** What Locus charges over provider cost. A placeholder until pricing is validated. */
export const MARKUP = 1.5;
/** Length of the per-client burst window. */
export const BURST_WINDOW_MS = 5 * 3_600_000;

export type UsageMeasurement =
  | {
      kind: "llm";
      /** e.g. "claude-sonnet-5-5" or "anthropic/claude-sonnet-5-5". */
      model: string;
      /** Uncached input tokens. */
      inputTokens: number;
      outputTokens: number;
      /** Input tokens served from the provider's prompt cache. */
      cachedInputTokens?: number;
    }
  | { kind: "image"; count: number; size: ImageSize }
  | { kind: "sandbox"; seconds: number };

export type ImageSize = "small" | "medium" | "large";

interface TokenRates {
  /** USD per million tokens. */
  input: number;
  output: number;
  cachedInput: number;
}

/**
 * Provider list prices by model-id prefix, USD per million tokens; the first match wins, so more
 * specific prefixes come first. Placeholders to keep current with the providers' price lists.
 */
const LLM_RATES: readonly (readonly [prefix: string, rates: TokenRates])[] = [
  ["claude-fable", { input: 10, output: 50, cachedInput: 1 }],
  ["claude-mythos", { input: 10, output: 50, cachedInput: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cachedInput: 0.2 }],
  ["claude-opus", { input: 5, output: 25, cachedInput: 0.5 }],
  ["claude-sonnet-5", { input: 2, output: 10, cachedInput: 0.2 }],
  ["claude-sonnet", { input: 3, output: 15, cachedInput: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cachedInput: 0.01 }],
  ["claude-haiku", { input: 1, output: 5, cachedInput: 0.1 }],
];

/** An unknown model is priced like the most expensive one we know, never for free. */
const DEFAULT_LLM_RATES: TokenRates = { input: 10, output: 50, cachedInput: 1 };

/** USD per generated image. Placeholders. */
const IMAGE_USD: Record<ImageSize, number> = { small: 0.02, medium: 0.04, large: 0.08 };

/** USD per sandbox second (about $0.36 an hour). A placeholder. */
const SANDBOX_USD_PER_SECOND = 0.0001;

function ratesFor(model: string): TokenRates {
  // Drop a router prefix such as "anthropic/".
  const id = model.toLowerCase().slice(model.lastIndexOf("/") + 1);
  return LLM_RATES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? DEFAULT_LLM_RATES;
}

/** What a measurement costs at the provider, in USD. */
export function providerCostUsd(m: UsageMeasurement): number {
  switch (m.kind) {
    case "llm": {
      const r = ratesFor(m.model);
      return (
        (nonNegative(m.inputTokens) * r.input +
          nonNegative(m.outputTokens) * r.output +
          nonNegative(m.cachedInputTokens ?? 0) * r.cachedInput) /
        1_000_000
      );
    }
    case "image":
      return nonNegative(m.count) * (IMAGE_USD[m.size] ?? IMAGE_USD.large);
    case "sandbox":
      return nonNegative(m.seconds) * SANDBOX_USD_PER_SECOND;
  }
}

/** A measurement's price in hundredths of a credit, rounded up. Pure. */
export function creditsFor(m: UsageMeasurement): number {
  const units = (providerCostUsd(m) * MARKUP * CREDIT) / USD_PER_CREDIT;
  // Allow for floating-point noise so an exact amount doesn't round up a whole unit.
  return Math.max(0, Math.ceil(units - 1e-9));
}

function nonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a usage amount: ${n}`);
  return n;
}

// Periods

/** The calendar month (UTC) containing `now`: its key ("YYYY-MM"), start and end. */
export function monthOf(now: Date): { key: string; start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(y, m, 1)),
    end: new Date(Date.UTC(y, m + 1, 1)),
  };
}

// Reads

const total = sql<number>`coalesce(sum(${usageMonth.credits}), 0)`.mapWith(Number);

/** The agency's credits this month: one rollup row per client, not every event. */
async function agencyMonthUsed(db: ControlDb, organizationId: string, now: Date) {
  const [row] = await db
    .select({ total })
    .from(usageMonth)
    .where(
      and(eq(usageMonth.organizationId, organizationId), eq(usageMonth.month, monthOf(now).key)),
    );
  return row?.total ?? 0;
}

async function locationMonthUsed(db: ControlDb, locationId: string, now: Date) {
  const [row] = await db
    .select({ credits: usageMonth.credits })
    .from(usageMonth)
    .where(and(eq(usageMonth.locationId, locationId), eq(usageMonth.month, monthOf(now).key)));
  return row?.credits ?? 0;
}

/** The client's events still inside the 5-hour window, oldest first. May span two months. */
async function windowEvents(db: ControlDb, locationId: string, now: Date) {
  return db
    .select({ credits: usageEvent.credits, createdAt: usageEvent.createdAt })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.locationId, locationId),
        gt(usageEvent.createdAt, new Date(now.getTime() - BURST_WINDOW_MS)),
        lt(usageEvent.createdAt, new Date(now.getTime() + 1)),
      ),
    )
    .orderBy(asc(usageEvent.createdAt));
}

/** The agency's extra credits used this month, from the same rollup. */
async function agencyOverageUsed(db: ControlDb, organizationId: string, now: Date) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageMonth.overageCredits}), 0)`.mapWith(Number) })
    .from(usageMonth)
    .where(
      and(eq(usageMonth.organizationId, organizationId), eq(usageMonth.month, monthOf(now).key)),
    );
  return row?.total ?? 0;
}

/** The agency's extra-usage setting, or null when it never turned it on. */
export async function usageOverageOf(db: ControlDb, organizationId: string) {
  const [row] = await db
    .select()
    .from(usageOverage)
    .where(eq(usageOverage.organizationId, organizationId));
  return row ?? null;
}

/**
 * The agency's extra-usage setting when it applies right now: turned on, and the agency pays on
 * an active subscription that isn't set to end. A trial has no paid invoice to carry extra usage,
 * and usage after a cancellation could land after the final invoice and never be billed.
 */
async function overageInEffect(db: ControlDb, organizationId: string) {
  const setting = await usageOverageOf(db, organizationId);
  if (!setting?.enabled) return null;
  const billed = await billableSubscription(db, organizationId);
  return billed?.status === "active" && !billed.cancelling ? setting : null;
}

async function limitRow(db: ControlDb, locationId: string) {
  const [row] = await db.select().from(usageLimit).where(eq(usageLimit.locationId, locationId));
  return row;
}

/** The client's ids, once `client` is known to have come from `authorizeClient`. */
function idsOf(client: AuthorizedClient) {
  assertAuthorizedClient(client);
  return { organizationId: client.location.organizationId, locationId: client.location.id };
}

// The allowance check

export type Allowance =
  | {
      ok: true;
      /** The smallest of the remaining amounts below; `null` when nothing limits it. */
      remaining: number | null;
      /** The plan's credits left this month, plus any extra credits still allowed. */
      agencyMonth: number | null;
      locationMonth: number | null;
      window: number | null;
    }
  | {
      ok: false;
      /** A sentence to show the user. */
      reason: string;
      /** When trying again can succeed, if waiting is enough. */
      retryAt?: Date;
    };

function entitlementRefusal(e: Entitlement): string {
  return e.status === "past_due" || e.status === "unpaid"
    ? "Your Locus payment is overdue. Update it on the Billing page to keep generating sites."
    : "Choose a Locus plan on the Billing page to generate sites.";
}

const formatCredits = (units: number) =>
  (units / CREDIT).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Whether the client may start more AI generation now. Refuses when the agency isn't entitled,
 * the client is paused, the agency's monthly credits or the client's monthly cap are used up,
 * or the client's 5-hour window is full. Comped agencies have no plan limits; a client's own
 * cap and pause still apply.
 *
 * Nothing is reserved: the check and `recordUsage` are separate, so generations started at the
 * same time all pass, and each can take the total past a limit by up to one generation's cost.
 * Limits are soft by that much; the first check after the records refuses.
 */
export async function checkAllowance(
  db: ControlDb,
  client: AuthorizedClient,
  opts: { now?: Date } = {},
): Promise<Allowance> {
  const { organizationId, locationId } = idsOf(client);
  const now = opts.now ?? new Date();
  const entitlement = await agencyEntitlement(db, organizationId);
  if (!entitlement.entitled) return { ok: false, reason: entitlementRefusal(entitlement) };

  const limit = await limitRow(db, locationId);
  if (limit?.paused) {
    return {
      ok: false,
      reason:
        "AI generation is paused for this client. An agency owner or admin can resume it on the Usage page.",
    };
  }

  const month = monthOf(now);
  const plan = entitlement.limits;

  let agencyMonth: number | null = null;
  if (plan?.creditsPerMonth != null) {
    agencyMonth = plan.creditsPerMonth - (await agencyMonthUsed(db, organizationId, now));
    const overage = agencyMonth <= 0 ? await overageInEffect(db, organizationId) : null;
    if (overage) {
      // The plan's credits are spent; what is left is the agency's own extra-usage limit.
      agencyMonth = overage.monthlyCreditLimit - (await agencyOverageUsed(db, organizationId, now));
      if (agencyMonth <= 0) {
        return {
          ok: false,
          reason: `Your agency has used this month's AI credits and its ${formatCredits(overage.monthlyCreditLimit)} extra credits. An owner or admin can raise the extra-usage limit on the Billing page.`,
          retryAt: month.end,
        };
      }
    } else if (agencyMonth <= 0) {
      return {
        ok: false,
        reason: `Your agency has used this month's ${formatCredits(plan.creditsPerMonth)} AI credits on the ${entitlement.plan?.title ?? ""} plan. Upgrade or turn on extra usage on the Billing page, or wait for next month.`,
        retryAt: month.end,
      };
    }
  }

  let locationMonth: number | null = null;
  if (limit?.monthlyCreditCap != null) {
    locationMonth = limit.monthlyCreditCap - (await locationMonthUsed(db, locationId, now));
    if (locationMonth <= 0) {
      return {
        ok: false,
        reason: `This client has reached its monthly cap of ${formatCredits(limit.monthlyCreditCap)} AI credits. An agency owner or admin can raise it on the Usage page.`,
        retryAt: month.end,
      };
    }
  }

  let window: number | null = null;
  if (plan?.creditsPer5Hours != null) {
    const events = await windowEvents(db, locationId, now);
    const used = events.reduce((sum, e) => sum + e.credits, 0);
    window = plan.creditsPer5Hours - used;
    if (window <= 0) {
      return {
        ok: false,
        reason: `This client has used its ${formatCredits(plan.creditsPer5Hours)} AI credits for the last 5 hours. Try again later.`,
        retryAt: rollOff(events, used, plan.creditsPer5Hours),
      };
    }
  }

  const finite = [agencyMonth, locationMonth, window].filter((n): n is number => n !== null);
  return {
    ok: true,
    remaining: finite.length ? Math.min(...finite) : null,
    agencyMonth,
    locationMonth,
    window,
  };
}

/** When enough of the window's oldest events leave it that some credit is free again. */
function rollOff(events: { credits: number; createdAt: Date }[], used: number, limit: number) {
  let left = used;
  for (const e of events) {
    left -= e.credits;
    if (left < limit) return new Date(e.createdAt.getTime() + BURST_WINDOW_MS);
  }
  // Unreachable while the window is over its limit; the newest event is the latest answer.
  const last = events.at(-1);
  return new Date((last?.createdAt.getTime() ?? 0) + BURST_WINDOW_MS);
}

// Recording usage

export interface UsageRecord {
  usage: UsageMeasurement;
  siteId?: string | null;
  /** The signed-in user who started the work, if any. */
  actorUserId?: string | null;
  now?: Date;
}

export interface UsageAlert {
  /** `overage` is the agency's extra-usage limit. */
  scope: "agency" | "location" | "overage";
  /** Null for the agency's monthly credits and its extra-usage limit. */
  locationId: string | null;
  /** "YYYY-MM", UTC. */
  period: string;
  /** Percentage of the limit that was crossed. */
  thresholdPercent: number;
  used: number;
  limit: number;
}

/** Thresholds of the agency's monthly credits, and of its extra-usage limit, that alert. */
const AGENCY_ALERTS = [80, 100] as const;

/**
 * Records one measurement for an authorized client, priced by `creditsFor`, and returns the
 * alerts it newly set off: the client reaching its `alert_at_percent` or 100% of its monthly cap,
 * the agency reaching 80% or 100% of its monthly credits. Each alert fires once per period
 * (`usage_alert`) and is written to the audit log in the same batch. See `checkAllowance` on
 * why there is no reservation.
 *
 * With extra usage on, the part of the event past the plan's monthly credits is marked as
 * overage in the same batch, so concurrent writers each see the totals before them and an extra
 * credit is never counted twice. It never goes past the agency's extra-usage limit: an event
 * that overshoots a limit (see above) is not billed for the part beyond it.
 */
export async function recordUsage(
  db: ControlDb,
  client: AuthorizedClient,
  record: UsageRecord,
): Promise<{ id: string; credits: number; overageCredits: number; alerts: UsageAlert[] }> {
  const { organizationId, locationId } = idsOf(client);
  const now = record.now ?? new Date();
  const period = monthOf(now).key;
  const credits = creditsFor(record.usage);
  const { kind, ...detail } = record.usage;
  const id = randomUUID();
  const { limits } = await agencyEntitlement(db, organizationId);
  const overage = await overageInEffect(db, organizationId);
  const included = overage ? (limits?.creditsPerMonth ?? null) : null;
  const inMonth = and(eq(usageMonth.organizationId, organizationId), eq(usageMonth.month, period));
  const writes = [
    db.insert(usageEvent).values({
      id,
      organizationId,
      locationId,
      siteId: record.siteId ?? null,
      actorUserId: record.actorUserId ?? null,
      kind,
      credits,
      detail,
      createdAt: now,
    }),
    db
      .insert(usageMonth)
      .values({ organizationId, locationId, month: period, credits })
      .onConflictDoUpdate({
        target: [usageMonth.locationId, usageMonth.month],
        set: { credits: sql`${usageMonth.credits} + excluded.credits` },
      }),
  ] as const;
  if (included === null || !overage) {
    await db.batch(writes);
  } else {
    // The agency's total now includes this event: whatever is past the plan's credits is extra,
    // up to what is left of the extra-usage limit. Read inside the batch, so writers serialize.
    const agencyTotal = sql`(select coalesce(sum(${usageMonth.credits}), 0) from ${usageMonth} where ${inMonth})`;
    const overageTotal = sql`(select coalesce(sum(${usageMonth.overageCredits}), 0) from ${usageMonth} where ${inMonth})`;
    await db.batch([
      ...writes,
      db
        .update(usageEvent)
        .set({
          overageCredits: sql`max(0, min(${credits}, ${agencyTotal} - ${included}, ${overage.monthlyCreditLimit} - ${overageTotal}))`,
        })
        .where(eq(usageEvent.id, id)),
      db
        .update(usageMonth)
        .set({
          overageCredits: sql`${usageMonth.overageCredits} + (select ${usageEvent.overageCredits} from ${usageEvent} where ${usageEvent.id} = ${id})`,
        })
        .where(and(eq(usageMonth.locationId, locationId), eq(usageMonth.month, period))),
    ]);
  }
  const [written] = await db
    .select({ overageCredits: usageEvent.overageCredits })
    .from(usageEvent)
    .where(eq(usageEvent.id, id));
  const overageCredits = written?.overageCredits ?? 0;

  const candidates: UsageAlert[] = [];

  const limit = await limitRow(db, locationId);
  if (limit?.monthlyCreditCap != null && limit.monthlyCreditCap > 0) {
    const used = await locationMonthUsed(db, locationId, now);
    for (const t of new Set([limit.alertAtPercent, 100])) {
      if (used * 100 >= limit.monthlyCreditCap * t) {
        candidates.push({
          scope: "location",
          locationId,
          period,
          thresholdPercent: t,
          used,
          limit: limit.monthlyCreditCap,
        });
      }
    }
  }

  if (limits?.creditsPerMonth != null && limits.creditsPerMonth > 0) {
    const used = await agencyMonthUsed(db, organizationId, now);
    for (const t of AGENCY_ALERTS) {
      if (used * 100 >= limits.creditsPerMonth * t) {
        candidates.push({
          scope: "agency",
          locationId: null,
          period,
          thresholdPercent: t,
          used,
          limit: limits.creditsPerMonth,
        });
      }
    }
  }

  if (overage && overage.monthlyCreditLimit > 0 && overageCredits > 0) {
    const used = await agencyOverageUsed(db, organizationId, now);
    for (const t of AGENCY_ALERTS) {
      if (used * 100 >= overage.monthlyCreditLimit * t) {
        candidates.push({
          scope: "overage",
          locationId: null,
          period,
          thresholdPercent: t,
          used,
          limit: overage.monthlyCreditLimit,
        });
      }
    }
  }

  const fired: UsageAlert[] = [];
  for (const alert of candidates) {
    const subject = alert.scope === "location" ? `location:${alert.locationId}` : alert.scope;
    // One batch, so an alert is never marked fired without its audit row. The unique key is the
    // once-per-period check, even with concurrent writers; the audit row's id is derived from the
    // same key, so a writer that lost the race adds no second audit row either.
    const [inserted] = await db.batch([
      db
        .insert(usageAlert)
        .values({
          id: randomUUID(),
          organizationId,
          subject,
          period,
          threshold: alert.thresholdPercent,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: usageAlert.id }),
      db
        .insert(auditLog)
        .values({
          id: `usage-alert:${organizationId}:${subject}:${period}:${alert.thresholdPercent}`,
          organizationId,
          actorUserId: record.actorUserId ?? null,
          locationId: alert.locationId,
          action: "usage.alert",
          detail: alert,
          createdAt: now,
        })
        .onConflictDoNothing(),
    ]);
    if (inserted.length > 0) fired.push(alert);
  }
  return { id, credits, overageCredits, alerts: fired };
}

// The usage page

export interface ClientUsage {
  locationId: string;
  /** Null for a client that has since been removed. */
  name: string | null;
  monthUsed: number;
  monthlyCreditCap: number | null;
  windowUsed: number;
  alertAtPercent: number;
  paused: boolean;
}

export interface UsageSummary {
  period: { key: string; start: Date; end: Date };
  /**
   * The agency's monthly credits; `limit` null means no plan limit (comped). Null unless the
   * caller is an owner or admin: the total covers clients a restricted member can't open.
   */
  agency: { used: number; limit: number | null } | null;
  /**
   * The agency's extra usage this month: null unless the caller is an owner or admin and the
   * agency has turned it on at some point. `used` is in `CREDIT` units, like `limit`.
   */
  overage: { enabled: boolean; used: number; limit: number } | null;
  /** The per-client burst limit over the last 5 hours; null means none. */
  windowLimit: number | null;
  clients: ClientUsage[];
}

async function isAgencyManager(db: ControlDb, ctx: SessionContext) {
  try {
    await requireAgencyManager(db, ctx);
    return true;
  } catch (e) {
    if (e instanceof ClientAccessDenied) return false;
    throw e;
  }
}

/**
 * Used and limits for the month and the 5-hour window, for the usage page.
 *
 * - Without `client`: every client of the session's agency. Owners and admins only.
 * - With `client` (from `authorizeClient` for this session's agency): that client only, and the
 *   agency's total only for owners and admins.
 */
export async function usageSummary(
  db: ControlDb,
  ctx: SessionContext,
  opts: { client?: AuthorizedClient; now?: Date } = {},
): Promise<UsageSummary> {
  const now = opts.now ?? new Date();
  const period = monthOf(now);

  let organizationId: string;
  let locationId: string | undefined;
  let manager: boolean;
  if (opts.client) {
    ({ organizationId, locationId } = idsOf(opts.client));
    if (ctx.activeOrganizationId !== organizationId) {
      throw new ClientAccessDenied("client is not in the session's agency");
    }
    manager = await isAgencyManager(db, ctx);
  } else {
    ({ organizationId } = await requireAgencyManager(db, ctx));
    manager = true;
  }

  const { limits } = await agencyEntitlement(db, organizationId);

  const monthRows = await db
    .select({ locationId: usageMonth.locationId, credits: usageMonth.credits })
    .from(usageMonth)
    .where(
      and(
        eq(usageMonth.organizationId, organizationId),
        eq(usageMonth.month, period.key),
        locationId ? eq(usageMonth.locationId, locationId) : undefined,
      ),
    );
  const windowTotal = sql<number>`coalesce(sum(${usageEvent.credits}), 0)`.mapWith(Number);
  const windowRows = await db
    .select({ locationId: usageEvent.locationId, total: windowTotal })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.organizationId, organizationId),
        locationId ? eq(usageEvent.locationId, locationId) : undefined,
        gt(usageEvent.createdAt, new Date(now.getTime() - BURST_WINDOW_MS)),
        lt(usageEvent.createdAt, new Date(now.getTime() + 1)),
      ),
    )
    .groupBy(usageEvent.locationId);
  const clients = await db
    .select({ id: location.id, name: location.name, limit: usageLimit })
    .from(location)
    .leftJoin(usageLimit, eq(usageLimit.locationId, location.id))
    .where(
      and(
        eq(location.organizationId, organizationId),
        locationId ? eq(location.id, locationId) : undefined,
      ),
    );

  const month = new Map(monthRows.map((r) => [r.locationId, r.credits]));
  const window = new Map(windowRows.map((r) => [r.locationId, r.total]));
  const rows: ClientUsage[] = clients.map((c) => ({
    locationId: c.id,
    name: c.name,
    monthUsed: month.get(c.id) ?? 0,
    monthlyCreditCap: c.limit?.monthlyCreditCap ?? null,
    windowUsed: window.get(c.id) ?? 0,
    alertAtPercent: c.limit?.alertAtPercent ?? 80,
    paused: c.limit?.paused ?? false,
  }));
  // Removed clients still count towards the month.
  const known = new Set(rows.map((r) => r.locationId));
  for (const [id, used] of month) {
    if (known.has(id)) continue;
    rows.push({
      locationId: id,
      name: null,
      monthUsed: used,
      monthlyCreditCap: null,
      windowUsed: window.get(id) ?? 0,
      alertAtPercent: 80,
      paused: false,
    });
  }

  let agency: UsageSummary["agency"] = null;
  let overage: UsageSummary["overage"] = null;
  if (manager) {
    const setting = await usageOverageOf(db, organizationId);
    if (setting) {
      overage = {
        enabled: setting.enabled,
        used: await agencyOverageUsed(db, organizationId, now),
        limit: setting.monthlyCreditLimit,
      };
    }
    agency = {
      used: locationId
        ? await agencyMonthUsed(db, organizationId, now)
        : rows.reduce((sum, r) => sum + r.monthUsed, 0),
      limit: limits?.creditsPerMonth ?? null,
    };
  }

  return {
    period,
    agency,
    overage,
    windowLimit: limits?.creditsPer5Hours ?? null,
    clients: rows.sort((a, b) => b.monthUsed - a.monthUsed),
  };
}

// Setting a client's limits

export interface UsageLimitChange {
  /** In `CREDIT` units; null removes the client's own cap. */
  monthlyCreditCap?: number | null;
  /** 1 to 100. */
  alertAtPercent?: number;
  paused?: boolean;
}

/**
 * Sets a client's cap, alert threshold or pause. Owners and admins of the session's agency
 * only; `client` must come from `authorizeClient` for that agency. Fields left out keep their
 * value. Audited.
 */
export async function setUsageLimit(
  db: ControlDb,
  ctx: SessionContext,
  client: AuthorizedClient,
  change: UsageLimitChange,
): Promise<typeof usageLimit.$inferSelect> {
  const { organizationId } = await requireAgencyManager(db, ctx);
  assertAuthorizedClient(client);
  if (client.location.organizationId !== organizationId) {
    throw new ClientAccessDenied("client is not in the session's agency");
  }
  const cap = change.monthlyCreditCap;
  if (cap != null && (!Number.isInteger(cap) || cap < 0)) {
    throw new RangeError("monthlyCreditCap must be a whole number of credit units, or null");
  }
  const pct = change.alertAtPercent;
  if (pct !== undefined && (!Number.isInteger(pct) || pct < 1 || pct > 100)) {
    throw new RangeError("alertAtPercent must be a whole number from 1 to 100");
  }

  const updatedAt = new Date();
  const set = {
    ...(cap !== undefined && { monthlyCreditCap: cap }),
    ...(pct !== undefined && { alertAtPercent: pct }),
    ...(change.paused !== undefined && { paused: change.paused }),
    updatedAt,
  };
  const locationId = client.location.id;
  const [, , [row]] = await db.batch([
    db
      .insert(usageLimit)
      .values({ locationId, ...set })
      .onConflictDoUpdate({ target: usageLimit.locationId, set }),
    db.insert(auditLog).values({
      id: randomUUID(),
      organizationId,
      actorUserId: ctx.userId,
      locationId,
      action: "usage.limit.set",
      detail: change,
    }),
    db.select().from(usageLimit).where(eq(usageLimit.locationId, locationId)),
  ]);
  if (!row) throw new Error("usage limit was not saved");
  return row;
}

// Extra usage

/** The most extra credits an agency may allow itself per month, in `CREDIT` units. */
export const MAX_OVERAGE_CREDITS = 1_000_000 * CREDIT;

export interface UsageOverageChange {
  enabled: boolean;
  /** Extra credits allowed per calendar month (UTC), in `CREDIT` units. */
  monthlyCreditLimit: number;
}

/**
 * Turns the session agency's extra usage on or off and sets its monthly limit. Owners and admins
 * only; the agency is the session's, never one the caller names. Audited. Billing it is the
 * caller's part: before turning it on, make sure the agency's subscription has the metered price
 * (`ensureOverageItem`), or Stripe records the usage without charging it.
 */
export async function setUsageOverage(
  db: ControlDb,
  ctx: SessionContext,
  change: UsageOverageChange,
): Promise<typeof usageOverage.$inferSelect> {
  const { organizationId } = await requireAgencyManager(db, ctx);
  const cap = change.monthlyCreditLimit;
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_OVERAGE_CREDITS) {
    throw new RangeError(
      `The extra-usage limit must be a whole number of credit units from 0 to ${MAX_OVERAGE_CREDITS}`,
    );
  }
  const set = { enabled: change.enabled, monthlyCreditLimit: cap, updatedAt: new Date() };
  const [, , [row]] = await db.batch([
    db
      .insert(usageOverage)
      .values({ organizationId, ...set })
      .onConflictDoUpdate({ target: usageOverage.organizationId, set }),
    db.insert(auditLog).values({
      id: randomUUID(),
      organizationId,
      actorUserId: ctx.userId,
      locationId: null,
      action: "usage.overage.set",
      detail: change,
    }),
    db.select().from(usageOverage).where(eq(usageOverage.organizationId, organizationId)),
  ]);
  if (!row) throw new Error("extra-usage setting was not saved");
  return row;
}
