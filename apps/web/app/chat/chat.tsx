"use client";

import {
  type AgentControllerCommandAck,
  type AgentControllerEvent,
  isKnownAgentControllerEvent,
  MastraClient,
  type MastraDBMessage,
} from "@mastra/client-js";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type Approval,
  applyUpdate,
  type ChatLine,
  lineOf,
  linesOf,
  pendingOf,
  type Question,
  questionOf,
} from "@/lib/chat-log";

type Session = ReturnType<ReturnType<MastraClient["getAgentController"]>["session"]>;

const RELOAD = "Reload the page to see where things stand.";

/**
 * The chat with the Locus agent for the active client, through Mastra's agent-controller API.
 * Requests go to this site's `/api/agent`, which the web app forwards to the agent server; the
 * sign-in cookie travels with them, and the agent server decides who and which client this is.
 */
export function Chat({ resource }: { resource: string }) {
  const session = useRef<Session | null>(null);
  const threadId = useRef<string | undefined>(undefined);
  const streaming = useRef(new Map<string, MastraDBMessage>());
  // Bumped whenever a run starts or the member sends, so a reload that began before it
  // doesn't overwrite what the new run shows.
  const generation = useRef(0);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [live, setLive] = useState<ChatLine[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  /** Replaces what's shown with the thread as stored, unless a newer run has started since. */
  const reload = useCallback(async () => {
    const current = session.current;
    if (!current) return;
    const started = generation.current;
    const state = await current.state();
    threadId.current = state.threadId ?? threadId.current;
    const messages = threadId.current ? await current.listMessages(threadId.current) : [];
    if (generation.current !== started || session.current !== current) return;
    setRunning(Boolean(state.running));
    setLines(linesOf(messages));
    streaming.current.clear();
    setLive([]);
  }, []);

  const reloadSoftly = useCallback(() => {
    void reload().catch(() => setProblem(`Couldn't load the conversation. ${RELOAD}`));
  }, [reload]);

  const showStreaming = useCallback(() => {
    setLive([...streaming.current.values()].flatMap((message) => lineOf(message) ?? []));
  }, []);

  const onEvent = useCallback(
    (event: AgentControllerEvent) => {
      if (!isKnownAgentControllerEvent(event)) return;
      switch (event.type) {
        case "agent_start":
          generation.current += 1;
          setRunning(true);
          break;
        case "agent_end":
          setRunning(false);
          if (event.reason === "error") setProblem("Something went wrong with that reply.");
          if (event.reason !== "suspended") {
            setApprovals([]);
            setQuestions([]);
          }
          reloadSoftly();
          break;
        case "display_state_changed": {
          // The session's own view of what it waits on, so a reload or reconnect restores it.
          const pending = pendingOf(event.displayState);
          setApprovals(pending.approvals);
          setQuestions(pending.questions);
          break;
        }
        case "thread_changed":
          threadId.current = event.threadId;
          reloadSoftly();
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
        case "tool_suspended":
          setQuestions((pending) => [
            ...pending.filter((q) => q.toolCallId !== event.toolCallId),
            questionOf(event.toolCallId, event.toolName, event.suspendPayload),
          ]);
          break;
        case "tool_suspension_cancelled":
        case "tool_end":
          setApprovals((pending) => pending.filter((a) => a.toolCallId !== event.toolCallId));
          setQuestions((pending) => pending.filter((q) => q.toolCallId !== event.toolCallId));
          break;
      }
    },
    [reloadSoftly, showStreaming],
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
      if (stopped) return;
      threadId.current = created.threadId;
      session.current = current;
      // Subscribe before loading the history: the server doesn't replay events, so anything
      // sent in between would otherwise be lost.
      const subscription = await current.subscribe({
        onEvent,
        onError: () => {
          if (!stopped) setProblem("Lost the connection to the assistant. Reload the page.");
        },
        onReconnect: reloadSoftly,
        reconnect: true,
      });
      if (stopped) {
        subscription.unsubscribe();
        return;
      }
      unsubscribe = () => subscription.unsubscribe();
      await reload();
      if (!stopped) setReady(true);
    })().catch(() => {
      if (!stopped) setProblem("Couldn't reach the assistant. Reload the page to try again.");
    });
    return () => {
      stopped = true;
      unsubscribe?.();
      if (session.current === current) session.current = null;
    };
  }, [resource, onEvent, reload, reloadSoftly]);

  // Keep the newest line in view as the conversation grows.
  const shown =
    lines.length +
    live.length +
    approvals.length +
    questions.length +
    (live.at(-1)?.text.length ?? 0);
  useEffect(() => {
    if (shown) bottom.current?.scrollIntoView({ block: "end" });
  }, [shown]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || running || !session.current) return;
    const id = `sent-${Date.now()}`;
    generation.current += 1;
    setDraft("");
    setProblem(null);
    setLines((shown) => [...shown, { id, role: "user", text }]);
    setRunning(true);
    await session.current.sendMessage(text).catch(() => {
      setRunning(false);
      setLines((shown) => shown.filter((line) => line.id !== id));
      setDraft(text);
      setProblem("That message didn't go through. Try again.");
    });
  }

  /** Reports an answer the session didn't take, and shows where things stand. */
  function settled(ack: AgentControllerCommandAck) {
    if (ack.ok) return;
    setProblem("That answer came too late; the assistant had moved on.");
    reloadSoftly();
  }

  async function decide(toolCallId: string, approved: boolean) {
    const current = session.current;
    if (!current) return;
    setApprovals((pending) => pending.filter((a) => a.toolCallId !== toolCallId));
    await current
      .approveTool(toolCallId, approved)
      .then(settled)
      .catch(() => setProblem(`Couldn't send your answer. ${RELOAD}`));
  }

  async function answer(toolCallId: string, reply: string | string[]) {
    const current = session.current;
    if (!current) return;
    setQuestions((pending) => pending.filter((q) => q.toolCallId !== toolCallId));
    await current
      .respondToToolSuspension(toolCallId, reply)
      .then(settled)
      .catch(() => setProblem(`Couldn't send your answer. ${RELOAD}`));
  }

  function stop() {
    session.current?.abort().catch(() => setProblem(`Couldn't stop the assistant. ${RELOAD}`));
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
        {questions.map((question) => (
          <QuestionCard
            key={question.toolCallId}
            question={question}
            onAnswer={(reply) => answer(question.toolCallId, reply)}
          />
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
            onClick={stop}
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

/** A question from the assistant: pick a choice, tick several, or type an answer. */
function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (reply: string | string[]) => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const box = "rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm";
  const button = "rounded-md border border-neutral-300 bg-white px-3 py-1";

  if (question.options.length > 0 && !question.multiple) {
    return (
      <div className={box}>
        <p className="font-medium">{question.question}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button key={option} type="button" onClick={() => onAnswer(option)} className={button}>
              {option}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (question.multiple) {
    return (
      <div className={box}>
        <p className="font-medium">{question.question}</p>
        <div className="mt-2 space-y-1">
          {question.options.map((option) => (
            <label key={option} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.includes(option)}
                onChange={(e) =>
                  setPicked((now) =>
                    e.target.checked ? [...now, option] : now.filter((o) => o !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={picked.length === 0}
          onClick={() => onAnswer(picked)}
          className={`mt-2 ${button} disabled:opacity-50`}
        >
          Answer
        </button>
      </div>
    );
  }
  return (
    <form
      className={box}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAnswer(text.trim());
      }}
    >
      <p className="font-medium">{question.question}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Your answer"
          className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-1"
        />
        <button type="submit" disabled={!text.trim()} className={`${button} disabled:opacity-50`}>
          Answer
        </button>
      </div>
    </form>
  );
}
