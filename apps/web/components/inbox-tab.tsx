"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { InboxView } from "@/lib/inbox";

/** Showing the tab again within this long reuses what was read, sparing GHL's request budget. */
const FRESH_MS = 30_000;

type Loaded = (InboxView & { ghlLocationId?: string }) | { state: "error" };

/** Where GoHighLevel opens one of the sub-account's conversations. */
const ghlConversationUrl = (ghlLocationId: string, conversationId: string) =>
  `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/conversations/conversations/${encodeURIComponent(conversationId)}`;

const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/**
 * The chat's Inbox tab: the sub-account's latest GHL conversations, asked for when the tab is
 * shown (`/api/inbox`, read live from GHL, never stored), so the chat page never waits on GHL.
 * Says whether new messages get a drafted reply; the drafts themselves are threads.
 */
export function InboxTab() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const readAt = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - readAt.current < FRESH_MS) return;
    readAt.current = Date.now();
    setLoading(true);
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      setView(res.ok ? ((await res.json()) as Loaded) : { state: "error" });
    } catch {
      setView({ state: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // A hidden tab panel has no box, so this sees the tab being chosen.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void load();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [load]);

  return (
    <div ref={ref} className="flex flex-col gap-3" aria-busy={loading}>
      {view === null ? (
        <p className="px-2 text-xs text-muted-foreground">Reading the inbox from GoHighLevel…</p>
      ) : (
        <InboxBody view={view} onRetry={() => void load(true)} />
      )}
    </div>
  );
}

function InboxBody({ view, onRetry }: { view: Loaded; onRetry: () => void }) {
  const note = "px-2 text-pretty text-xs text-muted-foreground";
  if (view.state === "not-configured") {
    return (
      <p className={note}>
        GoHighLevel isn&apos;t connected here, so there&apos;s no inbox to show.
      </p>
    );
  }
  const drafting = view.state !== "error" && view.drafting;
  return (
    <>
      {view.state !== "error" && (
        <p className={note}>
          {drafting ? (
            <>New messages get a drafted reply in a thread, sent only after someone approves it.</>
          ) : (
            <>
              Drafted replies are off for this sub-account. An owner or admin can turn them on under{" "}
              <Link href="/clients" className="underline">
                Sub-accounts
              </Link>
              .
            </>
          )}
        </p>
      )}
      {view.state === "ok" ? (
        view.conversations.length === 0 ? (
          <p className={note}>
            No conversations yet. Messages from contacts show up here as they come in.
          </p>
        ) : (
          <ul className="flex flex-col">
            {view.conversations.map((c) => (
              <li key={c.id}>
                <a
                  href={ghlConversationUrl(view.ghlLocationId ?? "", c.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in GoHighLevel"
                  className="flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${c.unread > 0 ? "font-semibold" : "font-medium"}`}
                    >
                      {c.contact}
                    </span>
                    {c.unread > 0 && (
                      <Badge>
                        <span className="sr-only">Unread: </span>
                        {c.unread}
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {c.channel}
                    {c.at && (
                      <>
                        {" · "}
                        <time dateTime={c.at}>{when.format(new Date(c.at))}</time>
                      </>
                    )}
                  </span>
                  {c.preview && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{c.preview}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className={note}>
          GoHighLevel didn&apos;t answer just now, so the inbox can&apos;t be shown.{" "}
          <button type="button" onClick={onRetry} className="underline">
            Try again
          </button>
        </p>
      )}
    </>
  );
}
