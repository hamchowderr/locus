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
  user,
} from "@locus/db/control";
import { eq } from "drizzle-orm";
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
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

async function subscribe(organizationId: string, plan = "starter", status = "active") {
  await db
    .insert(subscription)
    .values({ id: `sub-${organizationId}`, plan, referenceId: organizationId, status });
}

async function comp(organizationId: string) {
  await db
    .insert(user)
    .values({ id: "ops", name: "ops", email: "ops@x.test", emailVerified: true })
    .onConflictDoNothing();
  await db.insert(agencyComp).values({ organizationId, compedByUserId: "ops" });
}

/** Usage already on the books, in credit units, at a given time. */
async function spent(locationId: string, credits: number, at: Date, organizationId = "agency-a") {
  await db.insert(usageEvent).values({
    id: randomUUID(),
    organizationId,
    locationId,
    kind: "llm",
    credits,
    createdAt: at,
  });
}

async function signedIn(userId: string, role: string): Promise<SessionContext> {
  await db.insert(user).values({ id: userId, name: userId, email: `${userId}@a.test` });
  await db.insert(member).values({
    id: `${userId}@agency-a`,
    userId,
    organizationId: "agency-a",
    role,
    createdAt: NOW,
  });
  return { id: `session-${userId}`, userId, activeOrganizationId: "agency-a" };
}

const ids = (locationId = "a1", now = NOW) => ({ organizationId: "agency-a", locationId, now });

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
    expect(await checkAllowance(db, ids())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Choose a Locus plan/),
    });
    await subscribe("agency-a", "starter", "past_due");
    expect(await checkAllowance(db, ids())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/overdue/),
    });
  });

  it("allows a subscribed agency and reports what's left", async () => {
    await subscribe("agency-a");
    await spent("a1", 10 * CREDIT, new Date(NOW.getTime() - HOUR));
    expect(await checkAllowance(db, ids())).toEqual({
      ok: true,
      remaining: WINDOW_LIMIT - 10 * CREDIT,
      agencyMonth: MONTH_LIMIT - 10 * CREDIT,
      locationMonth: null,
      window: WINDOW_LIMIT - 10 * CREDIT,
    });
  });

  it("refuses another agency's client", async () => {
    await subscribe("agency-a");
    expect(await checkAllowance(db, ids("b1"))).toMatchObject({ ok: false });
  });

  it("refuses a paused client", async () => {
    await subscribe("agency-a");
    const owner = await signedIn("owner", "owner");
    await setUsageLimit(db, owner, await authorizeClient(db, owner, "a1"), { paused: true });
    expect(await checkAllowance(db, ids())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/paused/),
    });
    expect((await checkAllowance(db, ids("a2"))).ok).toBe(true);
  });

  it("refuses once the agency's monthly credits are gone, across all its clients", async () => {
    await subscribe("agency-a");
    // Last month's usage doesn't count.
    await spent("a2", MONTH_LIMIT, new Date("2026-09-30T23:59:59Z"));
    expect((await checkAllowance(db, ids())).ok).toBe(true);

    // Spread over several days, so the 5-hour window isn't what refuses.
    await spent("a2", MONTH_LIMIT / 2, new Date("2026-10-02T00:00:00Z"));
    await spent("a2", MONTH_LIMIT / 2, new Date("2026-10-05T00:00:00Z"));
    const refused = await checkAllowance(db, ids());
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/this month/) });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    // Another agency is unaffected.
    await subscribe("agency-b");
    expect((await checkAllowance(db, { ...ids("b1"), organizationId: "agency-b" })).ok).toBe(true);
  });

  it("refuses once a client reaches its own monthly cap", async () => {
    await subscribe("agency-a");
    const owner = await signedIn("owner", "owner");
    const a1 = await authorizeClient(db, owner, "a1");
    await setUsageLimit(db, owner, a1, { monthlyCreditCap: 20 * CREDIT });
    await spent("a1", 15 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    expect(await checkAllowance(db, ids())).toMatchObject({
      ok: true,
      remaining: 5 * CREDIT,
      locationMonth: 5 * CREDIT,
    });
    await spent("a1", 5 * CREDIT, new Date("2026-10-02T00:00:00Z"));
    const refused = await checkAllowance(db, ids());
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/monthly cap/) });
    expect(!refused.ok && refused.retryAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    // The cap is the client's own: its sibling is unaffected.
    expect((await checkAllowance(db, ids("a2"))).ok).toBe(true);
  });

  it("refuses a full 5-hour window until enough credits roll off", async () => {
    await subscribe("agency-a");
    const fourHoursAgo = new Date(NOW.getTime() - 4 * HOUR);
    await spent("a1", (WINDOW_LIMIT * 3) / 5, fourHoursAgo);
    await spent("a1", (WINDOW_LIMIT * 2) / 5, new Date(NOW.getTime() - HOUR));
    // Usage from six hours ago is outside the window.
    await spent("a1", WINDOW_LIMIT, new Date(NOW.getTime() - 6 * HOUR));

    const refused = await checkAllowance(db, ids());
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/5 hours/) });
    const retryAt = !refused.ok ? refused.retryAt : undefined;
    // The oldest event in the window leaves it five hours after it happened: an hour from now.
    expect(retryAt).toEqual(new Date(fourHoursAgo.getTime() + 5 * HOUR));
    expect((await checkAllowance(db, ids("a1", new Date(NOW.getTime() + HOUR - 1)))).ok).toBe(
      false,
    );
    expect(await checkAllowance(db, ids("a1", retryAt))).toMatchObject({
      ok: true,
      window: (WINDOW_LIMIT * 3) / 5,
    });
    // The window is per client.
    expect((await checkAllowance(db, ids("a2"))).ok).toBe(true);
  });

  it("gives a comped agency no plan limits, but still applies a client's own cap", async () => {
    await comp("agency-a");
    await spent("a1", MONTH_LIMIT * 10, new Date(NOW.getTime() - HOUR));
    expect(await checkAllowance(db, ids())).toEqual({
      ok: true,
      remaining: null,
      agencyMonth: null,
      locationMonth: null,
      window: null,
    });
    const owner = await signedIn("owner", "owner");
    await setUsageLimit(db, owner, await authorizeClient(db, owner, "a1"), {
      monthlyCreditCap: 100 * CREDIT,
    });
    expect(await checkAllowance(db, ids())).toMatchObject({ ok: false });
  });
});

describe("recordUsage and alerts", () => {
  it("records the priced event with its measurement", async () => {
    await subscribe("agency-a");
    const result = await recordUsage(db, {
      ...ids(),
      siteId: "site-1",
      actorUserId: "someone",
      usage: { kind: "llm", model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 },
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
  });

  it("fires a client's alert and its 100% alert once each per month", async () => {
    await subscribe("agency-a");
    const owner = await signedIn("owner", "owner");
    await setUsageLimit(db, owner, await authorizeClient(db, owner, "a1"), {
      monthlyCreditCap: 100 * CREDIT,
      alertAtPercent: 75,
    });
    const record = (now = NOW) => recordUsage(db, { ...ids("a1", now), usage: SANDBOX_1000S });

    for (let i = 0; i < 4; i++) expect((await record()).alerts).toEqual([]); // 60 credits
    // 75 credits is exactly 75%: reached, so it fires.
    expect((await record()).alerts).toEqual([
      expect.objectContaining({ scope: "location", thresholdPercent: 75, used: 75 * CREDIT }),
    ]);
    expect(await db.select().from(usageAlert)).toHaveLength(1);
    expect((await record()).alerts).toEqual([]); // 90
    const full = (await record()).alerts; // 105
    expect(full).toEqual([
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
    expect(audited.map((a) => (a.detail as { thresholdPercent: number }).thresholdPercent)).toEqual(
      expect.arrayContaining([75, 100]),
    );
    expect(audited).toHaveLength(2);

    // A new month starts over.
    const nextMonth = new Date("2026-11-02T00:00:00Z");
    expect((await record(nextMonth)).alerts).toEqual([]);
  });

  it("returns the alert from the call that crossed the threshold", async () => {
    await subscribe("agency-a");
    const owner = await signedIn("owner", "owner");
    await setUsageLimit(db, owner, await authorizeClient(db, owner, "a1"), {
      monthlyCreditCap: 20 * CREDIT,
    });
    const first = await recordUsage(db, { ...ids(), usage: SANDBOX_1000S }); // 15 of 20: 75%
    expect(first.alerts).toEqual([]);
    const second = await recordUsage(db, { ...ids(), usage: SANDBOX_1000S }); // 30 of 20
    expect(second.alerts.map((a) => a.thresholdPercent)).toEqual([80, 100]);
  });

  it("fires the agency's 80% and 100% alerts once per month", async () => {
    await subscribe("agency-a");
    await spent("a2", MONTH_LIMIT * 0.8 - 10 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    const crossed = await recordUsage(db, { ...ids(), usage: SANDBOX_1000S });
    expect(crossed.alerts).toEqual([
      expect.objectContaining({ scope: "agency", locationId: null, thresholdPercent: 80 }),
    ]);
    expect((await recordUsage(db, { ...ids(), usage: SANDBOX_1000S })).alerts).toEqual([]);

    await spent("a2", MONTH_LIMIT * 0.2, new Date("2026-10-02T00:00:00Z"));
    expect(
      (await recordUsage(db, { ...ids(), usage: SANDBOX_1000S })).alerts.map(
        (a) => a.thresholdPercent,
      ),
    ).toEqual([100]);
  });

  it("never fires plan alerts for a comped agency", async () => {
    await comp("agency-a");
    await spent("a1", MONTH_LIMIT * 2, new Date("2026-10-01T00:00:00Z"));
    expect((await recordUsage(db, { ...ids(), usage: SANDBOX_1000S })).alerts).toEqual([]);
  });
});

describe("usageSummary", () => {
  it("breaks the month and the window down per client", async () => {
    await subscribe("agency-a");
    await spent("a1", 30 * CREDIT, new Date("2026-10-01T00:00:00Z"));
    await spent("a1", 5 * CREDIT, new Date(NOW.getTime() - HOUR));
    await spent("a2", 50 * CREDIT, new Date(NOW.getTime() - 2 * HOUR));
    // A removed client's usage still counts towards the agency's month.
    await spent("gone", 7 * CREDIT, new Date("2026-10-03T00:00:00Z"));
    await spent("b1", 999 * CREDIT, NOW, "agency-b");

    const summary = await usageSummary(db, { organizationId: "agency-a", now: NOW });
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

    const one = await usageSummary(db, { organizationId: "agency-a", locationId: "a1", now: NOW });
    expect(one.clients.map((c) => c.locationId)).toEqual(["a1"]);
    expect(one.agency.used).toBe(92 * CREDIT);
  });
});

describe("setUsageLimit", () => {
  it("is for owners and admins only, never restricted staff", async () => {
    const staff = await signedIn("staff", "member");
    await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: "a1" });
    const theirs = await authorizeClient(db, staff, "a1");
    await expect(setUsageLimit(db, staff, theirs, { paused: true })).rejects.toBeInstanceOf(
      ClientAccessDenied,
    );

    const admin = await signedIn("admin", "member,admin");
    const saved = await setUsageLimit(db, admin, await authorizeClient(db, admin, "a1"), {
      monthlyCreditCap: 50 * CREDIT,
    });
    expect(saved).toMatchObject({
      monthlyCreditCap: 50 * CREDIT,
      alertAtPercent: 80,
      paused: false,
    });
  });

  it("keeps fields left out, clears a cap with null, and audits each change", async () => {
    const owner = await signedIn("owner", "owner");
    const a1 = await authorizeClient(db, owner, "a1");
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
    const owner = await signedIn("owner", "owner");
    const a1 = await authorizeClient(db, owner, "a1");
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
