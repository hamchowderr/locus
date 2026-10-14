import { randomUUID } from "node:crypto";
import type { ControlDb } from "@locus/db";
import { auditLog, location, usageAlert, usageEvent, usageLimit } from "@locus/db/control";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { agencyEntitlement, type Entitlement } from "./billing.ts";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  ClientAccessDenied,
  requireAgencyManager,
  type SessionContext,
} from "./client-access.ts";
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
 * Every function takes ids the caller resolved from the session (`AuthorizedClient`, the
 * session's active organisation) — never ids from a request.
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

const total = sql<number>`coalesce(sum(${usageEvent.credits}), 0)`.mapWith(Number);

async function agencyMonthUsed(db: ControlDb, organizationId: string, now: Date) {
  const { start, end } = monthOf(now);
  const [row] = await db
    .select({ total })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.organizationId, organizationId),
        gte(usageEvent.createdAt, start),
        lt(usageEvent.createdAt, end),
      ),
    );
  return row?.total ?? 0;
}

async function locationMonthUsed(db: ControlDb, locationId: string, now: Date) {
  const { start, end } = monthOf(now);
  const [row] = await db
    .select({ total })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.locationId, locationId),
        gte(usageEvent.createdAt, start),
        lt(usageEvent.createdAt, end),
      ),
    );
  return row?.total ?? 0;
}

/** The client's events still inside the 5-hour window, oldest first. */
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

async function limitRow(db: ControlDb, locationId: string) {
  const [row] = await db.select().from(usageLimit).where(eq(usageLimit.locationId, locationId));
  return row;
}

// The allowance check

export interface UsageIds {
  /** The session's active organisation. */
  organizationId: string;
  /** From an `AuthorizedClient`. */
  locationId: string;
  now?: Date;
}

export type Allowance =
  | {
      ok: true;
      /** The smallest of the remaining amounts below; `null` when nothing limits it. */
      remaining: number | null;
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
 */
export async function checkAllowance(db: ControlDb, ids: UsageIds): Promise<Allowance> {
  const now = ids.now ?? new Date();
  const entitlement = await agencyEntitlement(db, ids.organizationId);
  if (!entitlement.entitled) return { ok: false, reason: entitlementRefusal(entitlement) };

  const [loc] = await db
    .select({ id: location.id })
    .from(location)
    .where(and(eq(location.id, ids.locationId), eq(location.organizationId, ids.organizationId)));
  if (!loc) return { ok: false, reason: "This client isn't available." };

  const limit = await limitRow(db, ids.locationId);
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
    agencyMonth = plan.creditsPerMonth - (await agencyMonthUsed(db, ids.organizationId, now));
    if (agencyMonth <= 0) {
      return {
        ok: false,
        reason: `Your agency has used this month's ${formatCredits(plan.creditsPerMonth)} AI credits on the ${entitlement.plan?.title ?? ""} plan. Upgrade on the Billing page, or wait for next month.`,
        retryAt: month.end,
      };
    }
  }

  let locationMonth: number | null = null;
  if (limit?.monthlyCreditCap != null) {
    locationMonth = limit.monthlyCreditCap - (await locationMonthUsed(db, ids.locationId, now));
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
    const events = await windowEvents(db, ids.locationId, now);
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

export interface UsageRecord extends UsageIds {
  siteId?: string | null;
  /** The signed-in user who started the work, if any. */
  actorUserId?: string | null;
  usage: UsageMeasurement;
}

export interface UsageAlert {
  scope: "agency" | "location";
  /** Null for the agency's monthly credits. */
  locationId: string | null;
  /** "YYYY-MM", UTC. */
  period: string;
  /** Percentage of the limit that was crossed. */
  thresholdPercent: number;
  used: number;
  limit: number;
}

/** Thresholds of the agency's monthly credits that alert. */
const AGENCY_ALERTS = [80, 100] as const;

/**
 * Records one measurement, priced by `creditsFor`, and returns the alerts it newly set off: a
 * client reaching its `alert_at_percent` or 100% of its monthly cap, the agency reaching 80% or
 * 100% of its monthly credits. Each alert fires once per period (`usage_alert`) and goes in the
 * audit log.
 */
export async function recordUsage(
  db: ControlDb,
  record: UsageRecord,
): Promise<{ id: string; credits: number; alerts: UsageAlert[] }> {
  const now = record.now ?? new Date();
  const credits = creditsFor(record.usage);
  const { kind, ...detail } = record.usage;
  const id = randomUUID();
  await db.insert(usageEvent).values({
    id,
    organizationId: record.organizationId,
    locationId: record.locationId,
    siteId: record.siteId ?? null,
    actorUserId: record.actorUserId ?? null,
    kind,
    credits,
    detail,
    createdAt: now,
  });

  const period = monthOf(now).key;
  const candidates: UsageAlert[] = [];

  const limit = await limitRow(db, record.locationId);
  if (limit?.monthlyCreditCap != null && limit.monthlyCreditCap > 0) {
    const used = await locationMonthUsed(db, record.locationId, now);
    for (const t of new Set([limit.alertAtPercent, 100])) {
      if (used * 100 >= limit.monthlyCreditCap * t) {
        candidates.push({
          scope: "location",
          locationId: record.locationId,
          period,
          thresholdPercent: t,
          used,
          limit: limit.monthlyCreditCap,
        });
      }
    }
  }

  const { limits } = await agencyEntitlement(db, record.organizationId);
  if (limits?.creditsPerMonth != null && limits.creditsPerMonth > 0) {
    const used = await agencyMonthUsed(db, record.organizationId, now);
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

  const fired: UsageAlert[] = [];
  for (const alert of candidates) {
    const subject = alert.scope === "agency" ? "agency" : `location:${alert.locationId}`;
    // The unique key makes this the once-per-period check, even with concurrent writers.
    const inserted = await db
      .insert(usageAlert)
      .values({
        id: randomUUID(),
        organizationId: record.organizationId,
        subject,
        period,
        threshold: alert.thresholdPercent,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: usageAlert.id });
    if (inserted.length === 0) continue;
    await db.insert(auditLog).values({
      id: randomUUID(),
      organizationId: record.organizationId,
      actorUserId: record.actorUserId ?? null,
      locationId: alert.locationId,
      action: "usage.alert",
      detail: alert,
      createdAt: now,
    });
    fired.push(alert);
  }
  return { id, credits, alerts: fired };
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
  /** The agency's monthly credits; `limit` null means no plan limit (comped). */
  agency: { used: number; limit: number | null };
  /** The per-client burst limit over the last 5 hours; null means none. */
  windowLimit: number | null;
  clients: ClientUsage[];
}

/**
 * Used and limits for the month and the 5-hour window, per client. Pass `locationId` (from an
 * `AuthorizedClient`) to show one client only — for a member restricted to some clients, the
 * caller must, since the agency total covers clients they can't open.
 */
export async function usageSummary(
  db: ControlDb,
  ids: { organizationId: string; locationId?: string; now?: Date },
): Promise<UsageSummary> {
  const now = ids.now ?? new Date();
  const period = monthOf(now);
  const { limits } = await agencyEntitlement(db, ids.organizationId);
  const inAgency = eq(usageEvent.organizationId, ids.organizationId);
  const onlyOne = ids.locationId ? eq(usageEvent.locationId, ids.locationId) : undefined;

  const monthRows = await db
    .select({ locationId: usageEvent.locationId, total })
    .from(usageEvent)
    .where(
      and(
        inAgency,
        onlyOne,
        gte(usageEvent.createdAt, period.start),
        lt(usageEvent.createdAt, period.end),
      ),
    )
    .groupBy(usageEvent.locationId);
  const windowRows = await db
    .select({ locationId: usageEvent.locationId, total })
    .from(usageEvent)
    .where(
      and(
        inAgency,
        onlyOne,
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
        eq(location.organizationId, ids.organizationId),
        ids.locationId ? eq(location.id, ids.locationId) : undefined,
      ),
    );

  const month = new Map(monthRows.map((r) => [r.locationId, r.total]));
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
  for (const [locationId, used] of month) {
    if (known.has(locationId)) continue;
    rows.push({
      locationId,
      name: null,
      monthUsed: used,
      monthlyCreditCap: null,
      windowUsed: window.get(locationId) ?? 0,
      alertAtPercent: 80,
      paused: false,
    });
  }

  return {
    period,
    agency: {
      used: ids.locationId
        ? await agencyMonthUsed(db, ids.organizationId, now)
        : rows.reduce((sum, r) => sum + r.monthUsed, 0),
      limit: limits?.creditsPerMonth ?? null,
    },
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
