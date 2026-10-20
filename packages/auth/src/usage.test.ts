import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import {
  agencyComp,
  auditLog,
  location,
  member,
  memberLocation,
  organization,
  subscription,
  usageAlert,
  usageEvent,
  usageMonth,
  usageOverage,
  user,
} from "@locus/db/control";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  type SessionContext,
} from "./client-access.ts";
import { CREDIT, planNamed } from "./plans.ts";
import {
  checkAllowance,
  creditsFor,
  monthOf,
  recordUsage,
  setUsageLimit,
  setUsageOverage,
  type UsageMeasurement,
  usageSummary,
} from "./usage.ts";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-14T12:00:00Z");
const starter = planNamed("starter")?.limits;
if (!starter?.creditsPerMonth || !starter.creditsPer5Hours) throw new Error("starter limits");
const MONTH_LIMIT = starter.creditsPerMonth;
const WINDOW_LIMIT = starter.creditsPer5Hours;

/** 1,000 sandbox seconds: $0.10 at the provider, 15 credits. */
const SANDBOX_1000S: UsageMeasurement = { kind: "sandbox", seconds: 1_000 };

let dir: string;
let db: ControlDb;
let owner: SessionContext;
let staff: SessionContext;

async function addMember(userId: string, organizationId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@x.test` })
    .onConflictDoNothing();
  await db.insert(member).values({
    id: `${userId}@${organizationId}`,
    userId,
    organizationId,
    role,
    createdAt: NOW,
  });
  return { id: `session-${userId}`, userId, activeOrganizationId: organizationId };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-usage-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: NOW });
  }
  for (const id of ["a1", "a2", "b1"]) {
    await db.insert(location).values({
      id,
      organizationId: id.startsWith("a") ? "agency-a" : "agency-b",
      ghlLocationId: `ghl-${id}`,
      name: `Client ${id}`,
      tursoDbName: `loc-${id}`,
      tursoDbHostname: `loc-${id}.example.test`,
      status: "active",
    });
  }
  owner = await addMember("owner", "agency-a", "owner");
  staff = await addMember("staff", "agency-a", "member");
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "a1" });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const client = (locationId: string, ctx: SessionContext = owner) =>
  authorizeClient(db, ctx, locationId);

async function subscribe(
  organizationId: string,
  plan = "starter",
  status = "active",
  extra: Partial<typeof subscription.$inferInsert> = {},
) {
  await db.insert(subscription).values({
    id: `sub-${organizationId}`,
    plan,
    referenceId: organizationId,
    status,
    stripeCustomerId: `cus_${organizationId}`,
    stripeSubscriptionId: `sub_${organizationId}`,
    ...extra,
  });
}

async function comp(organizationId: string) {
  await db
    .insert(user)
    .values({ id: "ops", name: "ops", email: "ops@x.test", emailVerified: true })
    .onConflictDoNothing();
  await db.insert(agencyComp).values({ organizationId, compedByUserId: "ops" });
}

/** Usage already on the books, in credit units, at a given time — event and monthly rollup. */
async function spent(locationId: string, credits: number, at: Date, organizationId = "agency-a") {
  await db.insert(usageEvent).values({
    id: randomUUID(),
    organizationId,
    locationId,
    kind: "llm",
    credits,
    createdAt: at,
  });
  await db
    .insert(usageMonth)
    .values({ organizationId, locationId, month: monthOf(at).key, credits })
    .onConflictDoUpdate({
      target: [usageMonth.locationId, usageMonth.month],
      set: { credits: sql`${usageMonth.credits} + excluded.credits` },
    });
}

const check = async (locationId = "a1", now = NOW) =>
  checkAllowance(db, await client(locationId), { now });

describe("pricing", () => {
  it("prices tokens by model prefix, with a router prefix ignored", () => {
    const m = { kind: "llm", inputTokens: 1_000_000, outputTokens: 1_000_000 } as const;
    // Sonnet 5.5: $2 + $10 = $12 at the provider, × 1.5 = $18 = 1,800 credits.
    expect(creditsFor({ ...m, model: "claude-sonnet-5-5" })).toBe(1_800 * CREDIT);
    expect(creditsFor({ ...m, model: "anthropic/claude-sonnet-5-5" })).toBe(1_800 * CREDIT);
    // Opus 5.5 is more specific than the Opus family.
    expect(creditsFor({ ...m, model: "claude-opus-5-5" })).toBe(3_600 * CREDIT);
    expect(creditsFor({ ...m, model: "claude-opus-4-8" })).toBe(4_500 * CREDIT);
  });

  it("prices cached input at the cache rate", () => {
    const cached = creditsFor({
      kind: "llm",
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    // $0.20 × 1.5 = $0.30 = 30 credits.
    expect(cached).toBe(30 * CREDIT);
  });

  it("prices an unknown model like the most expensive one, never for free", () => {
    const unknown = creditsFor({
      kind: "llm",
      model: "some-new-model",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(unknown).toBe(1_500 * CREDIT);
  });

  it("rounds up to the next hundredth of a credit, and nothing is free", () => {
    const tiny = { kind: "llm", model: "claude-haiku-5-5", outputTokens: 0 } as const;
    expect(creditsFor({ ...tiny, inputTokens: 1 })).toBe(1);
    expect(creditsFor({ ...tiny, inputTokens: 0 })).toBe(0);
  });

  it("prices images and sandbox time", () => {
    // $0.04 an image × 2 × 1.5 = $0.12 = 12 credits.
    expect(creditsFor({ kind: "image", count: 2, size: "medium" })).toBe(12 * CREDIT);
    expect(creditsFor(SANDBOX_1000S)).toBe(15 * CREDIT);
  });

  it("refuses a negative or non-finite amount", () => {
    expect(() => creditsFor({ kind: "sandbox", seconds: -1 })).toThrow(RangeError);
    expect(() => creditsFor({ kind: "image", count: Number.NaN, size: "small" })).toThrow();
  });
});

describe("checkAllowance", () => {
  it("refuses an agency without a plan, or with an overdue one", async () => {
    expect(await check()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Choose a Locus plan/),
    });
    await subscribe("agency-a", "starter", "past_due");
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/overdue/) });
  });

  it("allows a subscribed agency and reports what's left", async () => {
    await subscribe("agency-a");
    await spent("a1", 10 * CREDIT, new Date(NOW.getTime() - HOUR));
    expect(await check()).toEqual({
      ok: true,
      remaining: WINDOW_LIMIT - 10 * CREDIT,
      agencyMonth: MONTH_LIMIT - 10 * CREDIT,
      locationMonth: null,
      window: WINDOW_LIMIT - 10 * CREDIT,
    });
  });

  it("refuses a client that didn't pass the access check", async () => {
    await subscribe("agency-a");
    const [b1] = await db.select().from(location).where(eq(location.id, "b1"));
    const forged = { location: b1, memberId: "owner@agency-a" } as AuthorizedClient;
    await expect(checkAllowance(db, forged)).rejects.toBeInstanceOf(ClientAccessDenied);
  });

  it("refuses a paused client", async () => {
    await subscribe("agency-a");
    await setUsageLimit(db, owner, await client("a1"), { paused: true });
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/paused/) });
    expect((await check("a2")).ok).toBe(true);
  });

  it("refuses once the agency's monthly credits are gone, across all its clients", async () => {
    await subscribe("agency-a");
    // Last month's usage doesn't count.
    await spent("a2", MONTH_LIMIT, new Date("2026-09-30T23:59:59Z"));
    expect((await check()).ok).toBe(true);

    // Spread over several days, so the 5-hour window isn't what refuses.
    await spent("a2", MONTH_LIMIT / 2, new Date("2026-10-02T00:00:00Z"));
    await spent("a2", MONTH_LIMIT / 2, new Date("2026-10-05T00:00:00Z"));
    const refused = await check();
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/this month/) });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T00:00:00Z"));

    // Another agency is unaffected.
    await subscribe("agency-b");
    const other = await addMember("other", "agency-b", "owner");
    const b1 = await authorizeClient(db, other, "b1");
    expect((await checkAllowance(db, b1, { now: NOW })).ok).toBe(true);
  });

  it("refuses once a client reaches its own monthly cap", async () => {
    await subscribe("agency-a");
    await setUsageLimit(db, owner, await client("a1"), { monthlyCreditCap: 20 * CREDIT });
    await spent("a1", 15 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    expect(await check()).toMatchObject({
      ok: true,
      remaining: 5 * CREDIT,
      locationMonth: 5 * CREDIT,
    });
    await spent("a1", 5 * CREDIT, new Date("2026-10-02T00:00:00Z"));
    const refused = await check();
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/monthly cap/) });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    // The cap is the client's own: its sibling is unaffected.
    expect((await check("a2")).ok).toBe(true);
  });

  it("refuses a full 5-hour window until enough credits roll off", async () => {
    await subscribe("agency-a");
    const fourHoursAgo = new Date(NOW.getTime() - 4 * HOUR);
    await spent("a1", (WINDOW_LIMIT * 3) / 5, fourHoursAgo);
    await spent("a1", (WINDOW_LIMIT * 2) / 5, new Date(NOW.getTime() - HOUR));
    // Usage from six hours ago is outside the window.
    await spent("a1", WINDOW_LIMIT, new Date(NOW.getTime() - 6 * HOUR));

    const refused = await check();
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/5 hours/) });
    const retryAt = !refused.ok ? refused.retryAt : undefined;
    // The oldest event in the window leaves it five hours after it happened: an hour from now.
    expect(retryAt).toEqual(new Date(fourHoursAgo.getTime() + 5 * HOUR));
    expect((await check("a1", new Date(NOW.getTime() + HOUR - 1))).ok).toBe(false);
    expect(await check("a1", retryAt)).toMatchObject({ ok: true, window: (WINDOW_LIMIT * 3) / 5 });
    // The window is per client.
    expect((await check("a2")).ok).toBe(true);
  });

  it("counts a 5-hour window across a month boundary, but each month on its own", async () => {
    await subscribe("agency-a");
    const lateOctober = new Date("2026-10-31T22:00:00Z");
    await spent("a1", (WINDOW_LIMIT * 3) / 5, lateOctober);
    await spent("a1", (WINDOW_LIMIT * 2) / 5, new Date("2026-11-01T00:30:00Z"));
    const now = new Date("2026-11-01T01:00:00Z");

    const refused = await check("a1", now);
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/5 hours/) });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T03:00:00Z"));

    const later = await check("a1", new Date("2026-11-01T03:00:00Z"));
    // November's total holds only November's usage.
    expect(later).toMatchObject({ ok: true, agencyMonth: MONTH_LIMIT - (WINDOW_LIMIT * 2) / 5 });
  });

  it("gives a comped agency no plan limits, but still applies a client's own cap", async () => {
    await comp("agency-a");
    await spent("a1", MONTH_LIMIT * 10, new Date(NOW.getTime() - HOUR));
    expect(await check()).toEqual({
      ok: true,
      remaining: null,
      agencyMonth: null,
      locationMonth: null,
      window: null,
    });
    await setUsageLimit(db, owner, await client("a1"), { monthlyCreditCap: 100 * CREDIT });
    expect(await check()).toMatchObject({ ok: false });
  });
});

describe("recordUsage and alerts", () => {
  const record = async (locationId = "a1", now = NOW) =>
    recordUsage(db, await client(locationId), { usage: SANDBOX_1000S, now });

  it("records the priced event, its measurement and the monthly rollup", async () => {
    await subscribe("agency-a");
    const result = await recordUsage(db, await client("a1"), {
      siteId: "site-1",
      actorUserId: "owner",
      usage: { kind: "llm", model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 },
      now: NOW,
    });
    expect(result.alerts).toEqual([]);
    const [row] = await db.select().from(usageEvent).where(eq(usageEvent.id, result.id));
    expect(row).toMatchObject({
      organizationId: "agency-a",
      locationId: "a1",
      siteId: "site-1",
      kind: "llm",
      credits: result.credits,
      detail: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 },
      createdAt: NOW,
    });
    // ($0.002 + $0.005) × 1.5 = $0.0105 = 1.05 credits.
    expect(result.credits).toBe(105);
    await record();
    expect(await db.select().from(usageMonth)).toEqual([
      {
        organizationId: "agency-a",
        locationId: "a1",
        month: "2026-10",
        credits: 105 + 1_500,
        overageCredits: 0,
      },
    ]);
  });

  it("refuses another agency's client and records nothing", async () => {
    await subscribe("agency-a");
    // The session can't authorize it...
    await expect(client("b1")).rejects.toBeInstanceOf(ClientAccessDenied);
    // ...and one built by hand is refused.
    const [b1] = await db.select().from(location).where(eq(location.id, "b1"));
    const forged = { location: b1, memberId: "owner@agency-a" } as AuthorizedClient;
    await expect(recordUsage(db, forged, { usage: SANDBOX_1000S })).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    expect(await db.select().from(usageEvent)).toEqual([]);
  });

  it("fires a client's alert and its 100% alert once each per month", async () => {
    await subscribe("agency-a");
    await setUsageLimit(db, owner, await client("a1"), {
      monthlyCreditCap: 100 * CREDIT,
      alertAtPercent: 75,
    });

    for (let i = 0; i < 4; i++) expect((await record()).alerts).toEqual([]); // 60 credits
    // 75 credits is exactly 75%: reached, so it fires.
    expect((await record()).alerts).toEqual([
      expect.objectContaining({ scope: "location", thresholdPercent: 75, used: 75 * CREDIT }),
    ]);
    expect(await db.select().from(usageAlert)).toHaveLength(1);
    expect((await record()).alerts).toEqual([]); // 90
    expect((await record()).alerts).toEqual([
      {
        scope: "location",
        locationId: "a1",
        period: "2026-10",
        thresholdPercent: 100,
        used: 105 * CREDIT,
        limit: 100 * CREDIT,
      },
    ]);
    expect((await record()).alerts).toEqual([]);

    const audited = await db.select().from(auditLog).where(eq(auditLog.action, "usage.alert"));
    expect(
      audited.map((a) => (a.detail as { thresholdPercent: number }).thresholdPercent).sort(),
    ).toEqual([100, 75]);

    // A new month starts over.
    expect((await record("a1", new Date("2026-11-02T00:00:00Z"))).alerts).toEqual([]);
  });

  it("returns the alert from the call that crossed the threshold", async () => {
    await subscribe("agency-a");
    await setUsageLimit(db, owner, await client("a1"), { monthlyCreditCap: 20 * CREDIT });
    expect((await record()).alerts).toEqual([]); // 15 of 20: 75%
    expect((await record()).alerts.map((a) => a.thresholdPercent)).toEqual([80, 100]); // 30
  });

  it("fires exactly one alert when concurrent records race past a threshold", async () => {
    await subscribe("agency-a");
    const a1 = await client("a1");
    await setUsageLimit(db, owner, a1, { monthlyCreditCap: 100 * CREDIT, alertAtPercent: 100 });
    await spent("a1", 90 * CREDIT, new Date("2026-10-01T00:00:00Z"));

    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })),
    );
    expect(results.flatMap((r) => r.alerts)).toHaveLength(1);
    expect(await db.select().from(usageAlert)).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "usage.alert"))).toHaveLength(
      1,
    );
    expect(await db.select().from(usageMonth)).toEqual([
      expect.objectContaining({ locationId: "a1", credits: 90 * CREDIT + 6 * 15 * CREDIT }),
    ]);
  });

  it("fires the agency's 80% and 100% alerts once per month", async () => {
    await subscribe("agency-a");
    await spent("a2", MONTH_LIMIT * 0.8 - 10 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    expect((await record()).alerts).toEqual([
      expect.objectContaining({ scope: "agency", locationId: null, thresholdPercent: 80 }),
    ]);
    expect((await record()).alerts).toEqual([]);

    await spent("a2", MONTH_LIMIT * 0.2, new Date("2026-10-02T00:00:00Z"));
    expect((await record()).alerts.map((a) => a.thresholdPercent)).toEqual([100]);
  });

  it("never fires plan alerts for a comped agency", async () => {
    await comp("agency-a");
    await spent("a1", MONTH_LIMIT * 2, new Date("2026-10-01T00:00:00Z"));
    expect((await record()).alerts).toEqual([]);
  });
});

describe("usageSummary", () => {
  beforeEach(async () => {
    await subscribe("agency-a");
    await spent("a1", 30 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    await spent("a1", 5 * CREDIT, new Date(NOW.getTime() - HOUR));
    await spent("a2", 50 * CREDIT, new Date(NOW.getTime() - 2 * HOUR));
    // A removed client's usage still counts towards the agency's month.
    await spent("gone", 7 * CREDIT, new Date("2026-10-03T00:00:00Z"));
    await spent("b1", 999 * CREDIT, NOW, "agency-b");
  });

  it("breaks the agency's month and window down per client, for owners and admins", async () => {
    const summary = await usageSummary(db, owner, { now: NOW });
    expect(summary.period).toEqual(monthOf(NOW));
    expect(summary.agency).toEqual({ used: 92 * CREDIT, limit: MONTH_LIMIT });
    expect(summary.windowLimit).toBe(WINDOW_LIMIT);
    expect(summary.clients).toEqual([
      expect.objectContaining({
        locationId: "a2",
        monthUsed: 50 * CREDIT,
        windowUsed: 50 * CREDIT,
      }),
      expect.objectContaining({ locationId: "a1", monthUsed: 35 * CREDIT, windowUsed: 5 * CREDIT }),
      expect.objectContaining({ locationId: "gone", name: null, monthUsed: 7 * CREDIT }),
    ]);

    const one = await usageSummary(db, owner, { client: await client("a1"), now: NOW });
    expect(one.clients.map((c) => c.locationId)).toEqual(["a1"]);
    expect(one.agency?.used).toBe(92 * CREDIT);
  });

  it("shows a restricted member their client only, without the agency's total", async () => {
    await expect(usageSummary(db, staff, { now: NOW })).rejects.toBeInstanceOf(ClientAccessDenied);
    const theirs = await usageSummary(db, staff, { client: await client("a1", staff), now: NOW });
    expect(theirs.agency).toBeNull();
    expect(theirs.clients).toEqual([
      expect.objectContaining({ locationId: "a1", monthUsed: 35 * CREDIT }),
    ]);
  });

  it("refuses a client from another agency than the session's", async () => {
    const other = await addMember("other", "agency-b", "owner");
    const b1 = await authorizeClient(db, other, "b1");
    await expect(usageSummary(db, owner, { client: b1 })).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
  });
});

describe("setUsageLimit", () => {
  it("is for owners and admins only, never restricted staff", async () => {
    const theirs = await client("a1", staff);
    await expect(setUsageLimit(db, staff, theirs, { paused: true })).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );

    const admin = await addMember("admin", "agency-a", "member,admin");
    const saved = await setUsageLimit(db, admin, await client("a1", admin), {
      monthlyCreditCap: 50 * CREDIT,
    });
    expect(saved).toMatchObject({
      monthlyCreditCap: 50 * CREDIT,
      alertAtPercent: 80,
      paused: false,
    });
  });

  it("keeps fields left out, clears a cap with null, and audits each change", async () => {
    const a1 = await client("a1");
    await setUsageLimit(db, owner, a1, { monthlyCreditCap: 50 * CREDIT, alertAtPercent: 90 });
    expect(await setUsageLimit(db, owner, a1, { paused: true })).toMatchObject({
      monthlyCreditCap: 50 * CREDIT,
      alertAtPercent: 90,
      paused: true,
    });
    expect(await setUsageLimit(db, owner, a1, { monthlyCreditCap: null })).toMatchObject({
      monthlyCreditCap: null,
      paused: true,
    });
    const audited = await db.select().from(auditLog).where(eq(auditLog.action, "usage.limit.set"));
    expect(audited).toHaveLength(3);
    expect(audited[0]).toMatchObject({ actorUserId: "owner", locationId: "a1" });
  });

  it("refuses a client that didn't pass the check, and bad values", async () => {
    const a1 = await client("a1");
    const [b1] = await db.select().from(location).where(eq(location.id, "b1"));
    const forged = { location: b1, memberId: "owner@agency-a" } as AuthorizedClient;
    await expect(setUsageLimit(db, owner, forged, { paused: true })).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );
    await expect(setUsageLimit(db, owner, a1, { alertAtPercent: 0 })).rejects.toThrow(RangeError);
    await expect(setUsageLimit(db, owner, a1, { monthlyCreditCap: -1 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("extra usage", () => {
  /** Spends all but `left` of the plan's credits, spread so the 5-hour window doesn't refuse. */
  async function spendPlan(left = 0) {
    await spent("a2", MONTH_LIMIT / 2, new Date("2026-10-02T00:00:00Z"));
    await spent("a2", MONTH_LIMIT / 2 - left, new Date("2026-10-05T00:00:00Z"));
  }
  const extra = (limit: number, enabled = true) =>
    setUsageOverage(db, owner, { enabled, monthlyCreditLimit: limit });

  it("keeps generating past the plan's credits while it's on, up to the agency's limit", async () => {
    await subscribe("agency-a");
    await spendPlan();
    expect(await check()).toMatchObject({ ok: false, reason: /turn on extra usage/ });

    await extra(20 * CREDIT);
    expect(await check()).toMatchObject({ ok: true, agencyMonth: 20 * CREDIT });

    // 15 credits each: the first is all extra; the second only fills the limit's last 5.
    const a1 = await client("a1");
    expect(await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })).toMatchObject({
      credits: 15 * CREDIT,
      overageCredits: 15 * CREDIT,
    });
    expect(await check()).toMatchObject({ ok: true, agencyMonth: 5 * CREDIT });
    expect(await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })).toMatchObject({
      overageCredits: 5 * CREDIT,
    });
    const refused = await check();
    expect(refused).toMatchObject({ ok: false, reason: /extra-usage limit/ });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T00:00:00Z"));

    // Next month starts with the plan's credits again, and nothing extra.
    const next = new Date("2026-11-02T12:00:00Z");
    expect(await recordUsage(db, a1, { usage: SANDBOX_1000S, now: next })).toMatchObject({
      overageCredits: 0,
    });
  });

  it("bills only the part of an event past the plan's credits", async () => {
    await subscribe("agency-a");
    await extra(100 * CREDIT);
    await spendPlan(10 * CREDIT);
    const a1 = await client("a1");
    const r = await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW });
    expect(r).toMatchObject({ credits: 15 * CREDIT, overageCredits: 5 * CREDIT });
    const rows = await db.select().from(usageMonth).where(eq(usageMonth.locationId, "a1"));
    expect(rows).toEqual([expect.objectContaining({ overageCredits: 5 * CREDIT })]);
  });

  it("never counts an extra credit twice when records race past the plan's credits", async () => {
    await subscribe("agency-a");
    await extra(1_000 * CREDIT);
    await spendPlan(30 * CREDIT);
    const a1 = await client("a1");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })),
    );
    // 6 × 15 = 90 credits, 30 of them inside the plan.
    const billed = results.reduce((sum, r) => sum + r.overageCredits, 0);
    expect(billed).toBe(60 * CREDIT);
    const [month] = await db
      .select({ total: sql<number>`sum(${usageMonth.overageCredits})`.mapWith(Number) })
      .from(usageMonth);
    expect(month?.total).toBe(60 * CREDIT);
  });

  it("stops at the plan's credits during a trial, or once the plan is set to end", async () => {
    await subscribe("agency-a", "starter", "trialing");
    await extra(100 * CREDIT);
    await spendPlan(10 * CREDIT);
    const a1 = await client("a1");
    expect((await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })).overageCredits).toBe(0);
    expect(await check()).toMatchObject({ ok: false, reason: /turn on extra usage/ });

    await db
      .update(subscription)
      .set({ status: "active", cancelAtPeriodEnd: true })
      .where(eq(subscription.referenceId, "agency-a"));
    expect((await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW })).overageCredits).toBe(0);
    expect((await check()).ok).toBe(false);
  });

  it("bills nothing while it's off, even when a generation overshoots the plan", async () => {
    await subscribe("agency-a");
    await extra(100 * CREDIT, false);
    await spendPlan(10 * CREDIT);
    const r = await recordUsage(db, await client("a1"), { usage: SANDBOX_1000S, now: NOW });
    expect(r.overageCredits).toBe(0);
  });

  it("is never needed by a comped agency", async () => {
    await comp("agency-a");
    await extra(100 * CREDIT);
    await spendPlan();
    expect((await check()).ok).toBe(true);
    const r = await recordUsage(db, await client("a1"), { usage: SANDBOX_1000S, now: NOW });
    expect(r.overageCredits).toBe(0);
  });

  it("fires the extra-usage 80% and 100% alerts once each", async () => {
    await subscribe("agency-a");
    // 15 of 18 is 83%; the next 15 fill the rest.
    await extra(18 * CREDIT);
    await spendPlan();
    const a1 = await client("a1");
    const extraAlerts = (r: { alerts: { scope: string }[] }) =>
      r.alerts.filter((a) => a.scope === "overage");
    const first = await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW });
    expect(extraAlerts(first)).toEqual([
      expect.objectContaining({ scope: "overage", thresholdPercent: 80 }),
    ]);
    const second = await recordUsage(db, a1, { usage: SANDBOX_1000S, now: NOW });
    expect(extraAlerts(second)).toEqual([
      expect.objectContaining({ scope: "overage", thresholdPercent: 100 }),
    ]);
  });

  it("shows owners and admins the month's extra usage", async () => {
    await subscribe("agency-a");
    await extra(20 * CREDIT);
    await spendPlan();
    await recordUsage(db, await client("a1"), { usage: SANDBOX_1000S, now: NOW });
    expect((await usageSummary(db, owner, { now: NOW })).overage).toEqual({
      enabled: true,
      used: 15 * CREDIT,
      limit: 20 * CREDIT,
    });
    const own = await usageSummary(db, staff, { client: await client("a1", staff), now: NOW });
    expect(own.overage).toBeNull();
  });

  it("is set by owners and admins only, with a sane limit, and audited", async () => {
    await expect(
      setUsageOverage(db, staff, { enabled: true, monthlyCreditLimit: CREDIT }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(extra(-1)).rejects.toThrow(RangeError);
    await expect(extra(1.5)).rejects.toThrow(RangeError);
    await extra(10 * CREDIT);
    await extra(30 * CREDIT, false);
    expect(await db.select().from(usageOverage)).toEqual([
      expect.objectContaining({
        organizationId: "agency-a",
        enabled: false,
        monthlyCreditLimit: 30 * CREDIT,
      }),
    ]);
    const audited = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "usage.overage.set"));
    expect(audited).toHaveLength(2);
  });
});
