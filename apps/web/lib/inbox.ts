import type { InboxConversation } from "@locus/connect";

/** What the chat's Inbox tab shows, as the browser gets it: dates as ISO strings. */
export type InboxView =
  | {
      state: "ok";
      drafting: boolean;
      conversations: (Omit<InboxConversation, "at"> & { at: string | null })[];
    }
  /** GoHighLevel didn't answer, or answered with an error, in time. */
  | { state: "unavailable"; drafting: boolean }
  /** This deployment has no GoHighLevel settings. */
  | { state: "not-configured" };

/** The longest the Inbox waits on GoHighLevel. */
export const INBOX_TIMEOUT_MS = 8_000;

const notConfigured = (e: unknown) => e instanceof Error && e.name === "NotConfigured";

/**
 * Reads the Inbox for one request, never throwing for GoHighLevel's sake: a failure or a slow
 * answer becomes "unavailable", missing settings "not-configured". `list` runs inside the
 * promise, so settings that throw while its dependencies are built are caught too. Only the
 * error's name is logged, since what GHL sends back can quote the sub-account's data.
 */
export async function readInbox(
  list: () => Promise<InboxConversation[]>,
  drafting: () => Promise<boolean>,
  timeoutMs = INBOX_TIMEOUT_MS,
): Promise<InboxView> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    const [isDrafting, found] = await Promise.all([
      drafting(),
      Promise.race([Promise.resolve().then(list), late]).catch((e: unknown) =>
        notConfigured(e) ? ("not-configured" as const) : e,
      ),
    ]);
    if (found === "not-configured") return { state: "not-configured" };
    if (found === "late" || !Array.isArray(found)) {
      if (found !== "late") {
        console.error("Inbox: reading conversations from GHL failed", (found as Error)?.name);
      }
      return { state: "unavailable", drafting: isDrafting };
    }
    return {
      state: "ok",
      drafting: isDrafting,
      conversations: found.map((c) => ({ ...c, at: c.at ? c.at.toISOString() : null })),
    };
  } finally {
    clearTimeout(timer);
  }
}
