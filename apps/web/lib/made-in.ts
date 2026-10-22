import type { ThreadItem } from "@/lib/agent-controller/use-threads";

/** The newest thread the main chat started that works on this site, if any. */
export function threadOf(all: ThreadItem[], siteId: string): ThreadItem | undefined {
  return all.find((t) => t.siteId === siteId && t.parentThreadId);
}
