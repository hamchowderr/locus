/**
 * GHL's burst limit is 100 requests per 10 seconds per location (and per agency for agency
 * tokens). Every agent, subagent and `query_data` fan-out acting on one client shares that
 * budget, so it is enforced here, in front of the one request path, rather than per caller.
 *
 * The window is per process. On serverless that means per instance, so a 429 is still possible
 * when several instances serve one client at once. A 429 is never retried in a loop: it pauses
 * the client's whole budget (`pause`) so every caller waits it out, and the request that got it
 * fails as usual.
 */

export interface RateLimitOptions {
  /** Requests allowed per window. GHL allows 100; the default keeps a little headroom. */
  limit?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GhlRateLimiter {
  /** Waits until `key` has room in its window, then takes a slot. */
  acquire(key: string): Promise<void>;
  /** GHL said 429: nothing for `key` is sent for `ms`. */
  pause(key: string, ms: number): void;
}

export const GHL_BURST_LIMIT = { limit: 90, windowMs: 10_000 } as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRateLimiter(options: RateLimitOptions = {}): GhlRateLimiter {
  const limit = options.limit ?? GHL_BURST_LIMIT.limit;
  const windowMs = options.windowMs ?? GHL_BURST_LIMIT.windowMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("limit must be a whole number ≥ 1");
  if (!(windowMs > 0)) throw new RangeError("windowMs must be positive");
  /** Start times of the requests in each key's current window, oldest first. */
  const windows = new Map<string, number[]>();
  /** When each paused key may send again. */
  const pausedUntil = new Map<string, number>();

  // Drop keys whose window has emptied, so a long-lived process does not keep every client.
  const sweep = (t: number) => {
    for (const [key, starts] of windows) {
      if ((starts.at(-1) ?? 0) <= t - windowMs) windows.delete(key);
    }
  };
  let lastSweep = now();

  return {
    async acquire(key) {
      for (;;) {
        const t = now();
        if (t - lastSweep > windowMs) {
          sweep(t);
          lastSweep = t;
        }
        const resume = pausedUntil.get(key) ?? 0;
        if (resume > t) {
          await sleep(resume - t);
          continue;
        }
        pausedUntil.delete(key);
        const starts = (windows.get(key) ?? []).filter((start) => start > t - windowMs);
        if (starts.length < limit) {
          starts.push(t);
          windows.set(key, starts);
          return;
        }
        windows.set(key, starts);
        // The window is full, so `starts` is not empty. The oldest request leaves the window first; wait for exactly that.
        await sleep((starts[0] as number) + windowMs - t);
      }
    },
    pause(key, ms) {
      pausedUntil.set(key, Math.max(pausedUntil.get(key) ?? 0, now() + ms));
    },
  };
}

/** One budget per process, shared by every request that does not bring its own. */
export const sharedRateLimiter: GhlRateLimiter = createRateLimiter();
