import type { ControlDb } from "@locus/db";
import { authRateLimit } from "@locus/db/control";
import { sql } from "drizzle-orm";

export interface AttemptRule {
  /** What the attempts are counted by. */
  by: "ip" | "email" | "email+ip";
  max: number;
  windowMs: number;
}

const MINUTE = 60 * 1000;

/**
 * How often sign-in, sign-up and verification-email attempts may come from one IP address, for
 * one email address from one IP, and for one email address from anywhere. Every attempt counts,
 * successful or not.
 *
 * Per IP slows guessing many accounts from one place. Per email and IP slows guessing one
 * account's password, and caps the verification emails a sign-up can trigger, without letting
 * someone else lock the owner out from elsewhere. The per-email ceiling is far higher, so only
 * guessing spread across many IPs reaches it.
 */
export const ATTEMPT_LIMITS: Record<string, AttemptRule[]> = {
  "/sign-in/email": [
    { by: "ip", max: 30, windowMs: 15 * MINUTE },
    { by: "email+ip", max: 10, windowMs: 15 * MINUTE },
    { by: "email", max: 100, windowMs: 15 * MINUTE },
  ],
  "/sign-up/email": [
    // Invited staff sign up here, often several from one office network.
    { by: "ip", max: 30, windowMs: 60 * MINUTE },
    { by: "email+ip", max: 3, windowMs: 60 * MINUTE },
    { by: "email", max: 20, windowMs: 60 * MINUTE },
  ],
  // Public over HTTP, and each call emails the address if it is unverified.
  "/send-verification-email": [
    { by: "ip", max: 10, windowMs: 60 * MINUTE },
    { by: "email+ip", max: 3, windowMs: 60 * MINUTE },
    // Well above the per-IP limit, so one IP can't use up an owner's resends.
    { by: "email", max: 30, windowMs: 60 * MINUTE },
  ],
};

const LONGEST_WINDOW_MS = Math.max(
  ...Object.values(ATTEMPT_LIMITS).flatMap((rules) => rules.map((rule) => rule.windowMs)),
);

/**
 * Counts one attempt against `key` and says whether it is within `max` for the current fixed
 * window. One statement, so concurrent attempts on several instances can't both read a stale
 * count. Returns how many seconds remain in the window when the attempt is over the limit.
 */
export async function consumeAttempt(
  db: ControlDb,
  key: string,
  rule: Pick<AttemptRule, "max" | "windowMs">,
  now = Date.now(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const t = authRateLimit;
  const expired = sql`${t.windowStart} <= ${now - rule.windowMs}`;
  const [row] = await db
    .insert(t)
    .values({ key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: t.key,
      // SQLite evaluates every assignment against the row as it was, so both see the old window.
      set: {
        count: sql`case when ${expired} then 1 else ${t.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${now} else ${t.windowStart} end`,
      },
    })
    .returning();
  if (!row) throw new Error("Counting an attempt returned no row");
  // A fresh window is a good moment to drop keys nobody has used for a while.
  if (row.count === 1) {
    await db.delete(t).where(sql`${t.windowStart} < ${now - LONGEST_WINDOW_MS}`);
  }
  if (row.count <= rule.max) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + rule.windowMs - now) / 1000)),
  };
}

/**
 * Checks every limit for `path` and returns the longest wait among those exceeded, or null
 * when the attempt may go ahead. Without an IP (no trusted header) only the per-email limit applies.
 */
export async function checkAttemptLimits(
  db: ControlDb,
  path: string,
  who: { ip: string | null; email: string },
): Promise<number | null> {
  let wait: number | null = null;
  for (const rule of ATTEMPT_LIMITS[path] ?? []) {
    const email = who.email.trim().toLowerCase();
    const value = { ip: who.ip, email, "email+ip": who.ip && `${email}|${who.ip}` }[rule.by];
    if (!value) continue;
    const result = await consumeAttempt(db, `${path}|${rule.by}|${value}`, rule);
    if (!result.allowed) wait = Math.max(wait ?? 0, result.retryAfterSeconds);
  }
  return wait;
}
