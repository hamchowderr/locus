"use client";

import { MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { threadOf } from "@/lib/made-in";

/** The sub-account's threads, read once for every card on the page. */
let threads: Promise<ThreadItem[]> | null = null;
const readThreads = () => {
  threads ??= fetch("/api/agent-controller/threads", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { threads: [] }))
    .then((data: { threads?: ThreadItem[] }) => data.threads ?? [])
    .catch(() => []);
  return threads;
};

/** Which thread made a site, linking to it in Chat. Nothing for a site no thread worked on. */
export function MadeIn({ siteId }: { siteId: string }) {
  const [thread, setThread] = useState<ThreadItem>();
  useEffect(() => {
    let live = true;
    void readThreads().then((all) => {
      if (live) setThread(threadOf(all, siteId));
    });
    return () => {
      live = false;
      // The next visit reads them fresh.
      threads = null;
    };
  }, [siteId]);
  if (!thread) return null;
  return (
    <Link
      href={`/chat#thread=${encodeURIComponent(thread.id)}`}
      className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <MessagesSquare className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Made in {thread.title || "a thread"}</span>
    </Link>
  );
}
