"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseSiteForChat } from "@/app/(app)/sites/[siteId]/visual-edits-actions";
import type { ToolViews } from "@/components/chat/tool-steps";
import { ChatView, Composer } from "@/components/chat-project/project-chat";
import { useAgentControllerChat } from "@/lib/agent-controller/use-agent-controller-chat";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { builderStep, savedVersion } from "@/lib/builder-steps";
import { cn } from "@/lib/utils";
import { VersionCard } from "./version-card";

/** The builder tools whose success means the site's files changed. */
const CHANGES_FILES = new Set(["files", "versions", "add_dependency"]);

const noThreads = new Map<string, ThreadItem>();

/**
 * One site's conversation with the site builder. It is the sub-account's newest conversation
 * tagged with this site, or a new one the first message makes (and tags), so a site keeps its
 * own history apart from the main chat. Every turn names the builder's mode and makes this
 * site the one it works on first, so nothing needs switching by hand.
 */
export function useSiteChat({
  siteId,
  mode,
  onFilesChanged,
}: {
  siteId: string;
  /** The site builder's mode id; null when there is no chat here. */
  mode: string | null;
  /** Called when a turn that changed the site's files ends. */
  onFilesChanged: () => void;
}) {
  const changed = useRef(false);
  const controller = useAgentControllerChat({
    onToolEnd: (tool) => {
      if (!tool.isError && CHANGES_FILES.has(tool.toolName)) changed.current = true;
    },
  });
  const [problem, setProblem] = useState<string | null>(null);

  // Open the site's conversation once, if it has one. Nothing is sent until this settles, so
  // a first message can't start a second conversation for the site.
  const [ready, setReady] = useState(false);
  const tagged = useRef<string | null>(null);
  const { openThread, activeThreadId } = controller;
  useEffect(() => {
    if (!mode) return;
    let stale = false;
    setReady(false);
    void (async () => {
      try {
        const res = await fetch("/api/agent-controller/threads", { cache: "no-store" });
        const data = (await res.json()) as { threads?: ThreadItem[] };
        const mine = (data.threads ?? []).find((t) => t.siteId === siteId && !t.archived);
        if (mine && !stale) {
          tagged.current = mine.id;
          await openThread(mine.id);
        }
      } catch {
        // No history to show; the first message starts the site's conversation.
      } finally {
        if (!stale) setReady(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [mode, siteId, openThread]);

  // A new conversation is tagged as this site's, so it opens here next time and stays out of
  // the main chat. A tag that didn't go through is tried again after the next turn.
  const busy = controller.status === "streaming";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `busy` re-runs it when a turn ends, which is the retry.
  useEffect(() => {
    if (!activeThreadId || tagged.current === activeThreadId) return;
    const id = activeThreadId;
    tagged.current = id;
    void fetch(`/api/agent-controller/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: siteId }),
    })
      .then((res) => {
        if (!res.ok && tagged.current === id) tagged.current = null;
      })
      .catch(() => {
        if (tagged.current === id) tagged.current = null;
      });
  }, [activeThreadId, siteId, busy]);

  // When a turn that changed files ends, show the result in the preview.
  const wasBusy = useRef(false);
  const filesChanged = useRef(onFilesChanged);
  filesChanged.current = onFilesChanged;
  useEffect(() => {
    if (wasBusy.current && !busy && changed.current) {
      changed.current = false;
      filesChanged.current();
    }
    wasBusy.current = busy;
  }, [busy]);

  const { sendMessage } = controller;
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!mode || !ready) return false;
      setProblem(null);
      // The builder works on the member's chosen site; this page's site is the one meant.
      const chosen = await chooseSiteForChat(siteId);
      if ("problem" in chosen) {
        setProblem(chosen.problem);
        return false;
      }
      return sendMessage(text, { mode });
    },
    [mode, ready, siteId, sendMessage],
  );

  return { controller, send, busy: busy || !ready, problem };
}

export type SiteChatState = ReturnType<typeof useSiteChat>;

/** What the site's chat needs to know about its versions. */
export type ChatVersions = {
  /** The newest saved version when the page loaded; 0 when there are none. */
  latest: number;
  /** The version in the preview, or null for the latest files. */
  shown: number | null;
  /** Whether this member may restore versions here. */
  canRestore: boolean;
};

/**
 * The site's chat panel: its conversation and the message box. The builder's tool calls
 * show as short step rows, and a turn that saved a version ends in that version's card.
 */
export function SiteChat({
  siteId,
  chat,
  refusal,
  versions,
  className,
}: {
  siteId: string;
  chat: SiteChatState;
  /** Why this member can't build the site; the chat is read-only then. */
  refusal: string | null;
  versions: ChatVersions;
  className?: string;
}) {
  // A version saved in this chat after the page loaded is newer than the page knows.
  let latest = versions.latest;
  for (const m of chat.controller.transcript.messages) {
    for (const p of m.content) {
      if (p.type !== "tool_result") continue;
      const out = (p as { result?: { saved?: unknown; version?: unknown } }).result;
      if (out?.saved === true && typeof out.version === "number" && out.version > latest) {
        latest = out.version;
      }
    }
  }
  const { shown, canRestore } = versions;
  const toolViews = useMemo<ToolViews>(
    () => ({
      step: builderStep,
      card: (call, result, turn) => {
        const saved = savedVersion(call, result, turn);
        return (
          saved && (
            <VersionCard
              siteId={siteId}
              saved={saved}
              latest={latest}
              shown={shown}
              canRestore={canRestore}
            />
          )
        );
      },
    }),
    [siteId, latest, shown, canRestore],
  );

  return (
    <aside className={cn("flex min-h-0 flex-col", className)}>
      <ChatView
        controller={chat.controller}
        emptyText="Tell the site builder what you want: a new section, different colours, another page. It changes the site and the preview updates."
        working={false}
        onOpenThread={() => undefined}
        onLinkClick={() => undefined}
        work={noThreads}
        toolViews={toolViews}
      />
      {chat.problem && <p className="px-3 text-destructive text-sm">{chat.problem}</p>}
      {refusal ? (
        <p className="border-t px-3 py-3 text-muted-foreground text-sm">{refusal}</p>
      ) : (
        <Composer
          placeholder="Describe a change to this site…"
          busy={chat.busy}
          onSend={(text) => chat.send(text)}
        />
      )}
    </aside>
  );
}
