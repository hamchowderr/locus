"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseSiteForChat } from "@/app/(app)/sites/[siteId]/visual-edits-actions";
import type { ToolViews } from "@/components/chat/tool-steps";
import { ChatView, Composer } from "@/components/chat-project/project-chat";
import { useAgentControllerChat } from "@/lib/agent-controller/use-agent-controller-chat";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { builderStep, callsChangedFiles, savedVersion } from "@/lib/builder-steps";
import { cn } from "@/lib/utils";
import { VersionCard } from "./version-card";

/** How often a thread working on the site in the background is read again. */
const THREAD_POLL_MS = 4_000;

const noThreads = new Map<string, ThreadItem>();

/**
 * One site's conversation with the site builder. It is the thread named by `threadId` (one the
 * main chat started to build this site), else the sub-account's newest conversation tagged with
 * this site, or a new one the first message makes (and tags), so a site keeps its own history
 * apart from the main chat. Every turn names the builder's mode and makes this site the one it
 * works on first, so nothing needs switching by hand. While a thread works on the site in the
 * background, its conversation and the preview follow along.
 */
export function useSiteChat({
  siteId,
  mode,
  threadId = null,
  onFilesChanged,
}: {
  siteId: string;
  /** The site builder's mode id; null when there is no chat here. */
  mode: string | null;
  /** A thread of the main chat's to open, if it is this site's. */
  threadId?: string | null;
  /** Called when a turn that changed the site's files ends. */
  onFilesChanged: () => void;
}) {
  // The tool calls that finished in the turn streaming now; whether they changed the site's
  // files is read from the conversation (their arguments and results) when the turn ends.
  const ended = useRef(new Set<string>());
  const controller = useAgentControllerChat({
    onToolEnd: (tool) => {
      if (!tool.isError) ended.current.add(tool.toolCallId);
    },
  });
  const messages = useRef(controller.transcript.messages);
  messages.current = controller.transcript.messages;
  const [problem, setProblem] = useState<string | null>(null);

  // Open the site's conversation once, if it has one. Nothing is sent until this settles, so
  // a first message can't start a second conversation for the site.
  const [ready, setReady] = useState(false);
  const tagged = useRef<string | null>(null);
  // The work thread on show, while it works in the background.
  const [working, setWorking] = useState<string | null>(null);
  const { openThread, activeThreadId } = controller;
  useEffect(() => {
    if (!mode) return;
    let stale = false;
    setReady(false);
    void (async () => {
      try {
        const res = await fetch("/api/agent-controller/threads", { cache: "no-store" });
        const data = (await res.json()) as { threads?: ThreadItem[] };
        const ofSite = (data.threads ?? []).filter((t) => t.siteId === siteId && !t.archived);
        // The thread asked for, else the site's own chat (never one of its threads).
        const mine = ofSite.find((t) => t.id === threadId) ?? ofSite.find((t) => !t.parentThreadId);
        if (mine && !stale) {
          tagged.current = mine.id;
          const { running } = await openThread(mine.id);
          // A thread's run may not have said it is working yet; the session knows.
          if (mine.parentThreadId && (running || mine.status === "working")) setWorking(mine.id);
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
  }, [mode, siteId, threadId, openThread]);

  // A thread working on the site in the background: read it again until it stops, showing its
  // conversation as it grows and the preview once it ends.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/agent-controller/threads", { cache: "no-store" });
        const data = (await res.json()) as { threads?: ThreadItem[] };
        const now = data.threads?.find((t) => t.id === working);
        const { running } = await openThread(working);
        if (!running && now?.status !== "working") {
          setWorking(null);
          filesChanged.current();
        }
      } catch {
        // Tried again on the next tick.
      }
    }, THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [working, openThread]);

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
    if (wasBusy.current && !busy && ended.current.size > 0) {
      const ids = ended.current;
      ended.current = new Set();
      if (callsChangedFiles(messages.current, ids)) filesChanged.current();
    }
    wasBusy.current = busy;
  }, [busy]);

  const { sendMessage } = controller;
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!mode || !ready || working) return false;
      setProblem(null);
      // The builder works on the member's chosen site; this page's site is the one meant.
      const chosen = await chooseSiteForChat(siteId);
      if ("problem" in chosen) {
        setProblem(chosen.problem);
        return false;
      }
      return sendMessage(text, { mode });
    },
    [mode, ready, working, siteId, sendMessage],
  );

  return { controller, send, busy: busy || !ready || working !== null, problem };
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
      // A save names its version; a restore makes a new one too.
      const out = (p as { result?: { saved?: unknown; version?: unknown; nowVersion?: unknown } })
        .result;
      const made =
        out?.saved === true && typeof out.version === "number" ? out.version : out?.nowVersion;
      if (typeof made === "number" && made > latest) latest = made;
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
          // Only a turn streaming here can be stopped, not the page still opening the chat.
          onStop={chat.controller.status === "streaming" ? chat.controller.stop : undefined}
        />
      )}
    </aside>
  );
}
