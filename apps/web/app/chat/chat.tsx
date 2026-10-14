"use client";

import {
  type AgentControllerEvent,
  isKnownAgentControllerEvent,
  MastraClient,
  type MastraDBMessage,
} from "@mastra/client-js";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { applyUpdate, type ChatLine, lineOf, linesOf } from "@/lib/chat-log";

type Approval = { toolCallId: string; toolName: string; args: unknown };
type Session = ReturnType<ReturnType<MastraClient["getAgentController"]>["session"]>;

/**
 * The chat with the Locus agent for the active client, through Mastra's agent-controller API.
 * Requests go to this site's `/api/agent`, which the web app forwards to the agent server; the
 * sign-in cookie travels with them, and the agent server decides who and which client this is.
 */
export function Chat({ resource }: { resource: string }) {
  const session = useRef<Session | null>(null);
  const threadId = useRef<string | undefined>(undefined);
  const streaming = useRef(new Map<string, MastraDBMessage>());
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [live, setLive] = useState<ChatLine[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  /** Replaces what's shown with the thread as stored, once a run is over or after a gap. */
  const reload = useCallback(async () => {
    const current = session.current;
    if (!current) return;
    const state = await current.state();
    threadId.current = state.threadId ?? threadId.current;
    setRunning(Boolean(state.running));
    if (!threadId.current) return;
    setLines(linesOf(await current.listMessages(threadId.current)));
    streaming.current.clear();
    setLive([]);
  }, []);

  const showStreaming = useCallback(() => {
    setLive([...streaming.current.values()].flatMap((message) => lineOf(message) ?? []));
  }, []);

  const onEvent = useCallback(
    (event: AgentControllerEvent) => {
      if (!isKnownAgentControllerEvent(event)) return;
      switch (event.type) {
        case "agent_start":
          setRunning(true);
          break;
        case "agent_end":
          setRunning(false);
          setApprovals([]);
          void reload().catch(() => setProblem("Couldn't load the conversation. Reload the page."));
          break;
        case "thread_changed":
          threadId.current = event.threadId;
          break;
        case "message_start":
          if (event.message.role !== "assistant") break;
          streaming.current.set(event.message.id, structuredClone(event.message));
          showStreaming();
          break;
        case "message_update": {
          const message = streaming.current.get(event.id);
          if (!message) break;
          streaming.current.set(event.id, applyUpdate(message, event.event));
          showStreaming();
          break;
        }
        case "tool_approval_required":
          setApprovals((pending) => [
            ...pending.filter((a) => a.toolCallId !== event.toolCallId),
            { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
          ]);
          break;
        case "tool_end":
          setApprovals((pending) => pending.filter((a) => a.toolCallId !== event.toolCallId));
          break;
      }
    },
    [reload, showStreaming],
  );

  useEffect(() => {
    const client = new MastraClient({
      baseUrl: window.location.origin,
      apiPrefix: "/api/agent",
      retries: 0,
    });
    const current = client.getAgentController("locus").session(resource);
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const created = await current.create();
      threadId.current = created.threadId;
      session.current = current;
      await reload();
      const subscription = await current.subscribe({
        onEvent,
        onError: () => {
          if (!stopped) setProblem("Lost the connection to the assistant. Reload the page.");
        },
        onReconnect: () => {
          void reload().catch(() => undefined);
        },
        reconnect: true,
      });
      if (stopped) subscription.unsubscribe();
      else {
        unsubscribe = () => subscription.unsubscribe();
        setReady(true);
      }
    })().catch(() => {
      if (!stopped) setProblem("Couldn't reach the assistant. Reload the page to try again.");
    });
    return () => {
      stopped = true;
      unsubscribe?.();
      session.current = null;
    };
  }, [resource, onEvent, reload]);

  // Keep the newest line in view as the conversation grows.
  const shown = lines.length + live.length + approvals.length + (live.at(-1)?.text.length ?? 0);
  useEffect(() => {
    if (shown) bottom.current?.scrollIntoView({ block: "end" });
  }, [shown]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !session.current) return;
    setDraft("");
    setProblem(null);
    setLines((shown) => [...shown, { id: `sent-${Date.now()}`, role: "user", text }]);
    setRunning(true);
    await session.current.sendMessage(text).catch(() => {
      setRunning(false);
      setProblem("That message didn't go through. Try again.");
    });
  }

  async function decide(toolCallId: string, approved: boolean) {
    setApprovals((pending) => pending.filter((a) => a.toolCallId !== toolCallId));
    await session.current?.approveTool(toolCallId, approved).catch(() => {
      setProblem("Couldn't send your answer. Reload the page to see where things stand.");
    });
  }

  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {ready && lines.length === 0 && live.length === 0 && (
          <p className="text-sm text-neutral-500">Ask the assistant about this client.</p>
        )}
        {[...lines, ...live].map((line) => (
          <p
            key={line.id}
            className={`whitespace-pre-wrap rounded-md px-3 py-2 text-sm ${
              line.role === "user" ? "ml-10 bg-neutral-900 text-white" : "mr-10 bg-neutral-100"
            }`}
          >
            {line.text}
          </p>
        ))}
        {approvals.map((approval) => (
          <div
            key={approval.toolCallId}
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
          >
            <p className="font-medium">The assistant wants to make a change. Allow it?</p>
            <pre className="mt-1 overflow-x-auto text-xs text-neutral-700">
              {approval.toolName} {JSON.stringify(approval.args, null, 2)}
            </pre>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => decide(approval.toolCallId, true)}
                className="rounded-md bg-neutral-900 px-3 py-1 text-white"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => decide(approval.toolCallId, false)}
                className="rounded-md border border-neutral-300 px-3 py-1"
              >
                Decline
              </button>
            </div>
          </div>
        ))}
        {problem && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {problem}
          </p>
        )}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="mt-4 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? "Message the assistant" : "Connecting…"}
          disabled={!ready}
          aria-label="Message"
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
        />
        {running ? (
          <button
            type="button"
            onClick={() => void session.current?.abort()}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!ready || !draft.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
