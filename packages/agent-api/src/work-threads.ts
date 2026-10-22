/**
 * Work threads for one client's chat: the main chat's agent hands a piece of work to a thread of
 * its own (`start_thread`), which runs in the background and reports back in the main chat. The
 * mechanics are the chat kit's (`mastra/lib/work-threads.ts`); this binds them to a Locus
 * controller.
 *
 * The tool has to be in the controller's `tools` when it is made, and the work threads need the
 * controller, so the host makes these first, passes `tool` to `createLocusController`, then
 * calls `attach` with the controller.
 *
 * What a thread may do is what the run that started it could do:
 * - Its runs carry the starting run's request context (the member's session, so every GHL call
 *   still runs the staff check, and the host's values), minus Mastra's own keys.
 * - A run that read untrusted content approves every change, and a thread starts from the brief
 *   alone, so in such a run `start_thread` itself waits for the person's yes, and the thread is
 *   kept as `untrusted`: every run in it is tainted (see `kit.ts`), so its changes wait too.
 * - Every run the kit starts in an `untrusted` thread (its brief, a message from the main chat)
 *   is tainted too, whatever the main chat's run was.
 * - A report carries the thread's own words into the main chat, so what reads like
 *   instructions in it is withheld, as in any GHL data. A run that read untrusted content (or
 *   any run in an untrusted thread) reports only how it ended: the supervisor reads the rest
 *   with `read_thread`, which taints its run.
 * - Its sessions get no grants: Locus's approval rules hold there as everywhere.
 *
 * The main chat is a supervisor (`SUPERVISOR_MODE`): it reads and answers, and hands every
 * change to a thread run by one of the specialist agents (`ThreadAgent`), each a controller
 * mode with its own instructions and tools. It follows its threads with `list_threads` and
 * `read_thread` (their words are untrusted, like GHL data) and steers them with
 * `message_thread`, which waits for the person's yes in a tainted run, as `start_thread` does.
 * At most `MAX_WORKING_THREADS` work at once per client, to keep model costs down; the rest
 * queue.
 */

import {
  ASK_TOOLS,
  hasRefusedBrief,
  isTainted,
  OWN_STATE_TOOLS,
  REFUSED_BRIEF_MARK,
  TAINT_KEY,
  TAINT_MARK,
  withholdInstructions,
} from "@locus/harness";
import type { AgentController, AgentControllerMode } from "@mastra/core/agent-controller";
import type { MastraStorage } from "@mastra/core/storage";
import {
  SITE_THREAD_KEY,
  START_THREAD_TOOL,
  siteOf,
  workThreadOf,
} from "./mastra/lib/work-thread-info.ts";
import {
  LIST_THREADS_TOOL,
  MESSAGE_THREAD_TOOL,
  READ_THREAD_TOOL,
  SUGGEST_THREADS_TOOL,
} from "./mastra/lib/work-thread-steering.ts";
import {
  createWorkThreads,
  type ThreadAgent,
  type WorkThreads,
} from "./mastra/lib/work-threads.ts";

/** The agent that reads and changes the sub-account's GoHighLevel records. */
export const OPERATOR_AGENT: ThreadAgent = {
  id: "operator",
  name: "GoHighLevel operator",
  description:
    "Reads and changes this sub-account's GoHighLevel records: contacts, conversations, opportunities, calendars, invoices, tags, workflows and the rest.",
  modeId: "act",
};

export const SUPERVISOR_MODE_ID = "supervisor";

/** How many of a client's threads may work at once; later ones queue. */
export const MAX_WORKING_THREADS = 3;

/** The supervisor's tools for the threads it started. */
export const STEERING_TOOLS = [
  SUGGEST_THREADS_TOOL,
  LIST_THREADS_TOOL,
  READ_THREAD_TOOL,
  MESSAGE_THREAD_TOOL,
] as const;

/** The main chat: reads and answers itself, and hands every change to a thread. */
export const SUPERVISOR_MODE: AgentControllerMode = {
  id: SUPERVISOR_MODE_ID,
  name: "Supervisor",
  description: "Answers questions about the sub-account and hands work to agents in threads.",
  instructions: `You are this sub-account's main chat. You answer questions yourself, reading with
load_skill and query_data. You change nothing here: hand every change, and any work of several
steps, to a thread with start_thread, choosing the agent that fits, and give it a full brief. A
request with several parts (a website, a funnel page and an email campaign, say) gets one thread
per part. Work in the client's connected apps goes to a thread too. Then say in a sentence or
two which threads you started. When the person asks what could be done for this sub-account, or
a request could split into work they may not all want, offer threads with suggest_threads instead
of starting them, then stop: they pick on the card, and you start the ones they name with
start_thread, using each suggestion's title, brief and agent unchanged. To say how the work is
going, use list_threads and read_thread. To change a thread's plan, or pass on what the person
says about it, use message_thread rather than starting another thread. At most ${MAX_WORKING_THREADS} threads work at once; the rest wait
their turn, so tell the person when one is queued.`,
  availableTools: [
    ...new Set([...ASK_TOOLS, ...OWN_STATE_TOOLS, START_THREAD_TOOL, ...STEERING_TOOLS]),
  ],
};

const attached = new WeakMap<AgentController, WorkThreads>();

/** Work threads over one client's store, to attach to that client's controller once made. */
export function clientWorkThreads(
  storage: MastraStorage,
  agents: readonly ThreadAgent[] = [OPERATOR_AGENT],
) {
  let attach!: (controller: AgentController) => void;
  const controller = new Promise<AgentController>((resolve) => {
    attach = resolve;
  });
  const threads = createWorkThreads({
    getController: () => controller,
    storage,
    agents,
    maxWorking: MAX_WORKING_THREADS,
    requireApproval: (context) => isTainted(context) || hasRefusedBrief(context),
    startsUntrusted: isTainted,
    // A suggestion refused for a tainted run keeps its briefs in the chat's history, so its
    // result is marked: a later run that reads it asks before starting or messaging a thread,
    // or making any change, without being tainted itself.
    refusedSuggestion: { refusedBrief: REFUSED_BRIEF_MARK },
    runContext: (context, thread) => {
      if (thread.untrusted) context.set(TAINT_KEY, true);
    },
    // A run that read untrusted content reports how it ended, never what it said.
    reportsWords: ({ thread, runMessages }) =>
      !thread.untrusted && !JSON.stringify(runMessages).includes(TAINT_MARK),
    screenReport: (text) => {
      const screened = withholdInstructions(text).value;
      return typeof screened === "string" ? screened : "";
    },
  });
  return {
    /** The `start_thread` tool, for `createLocusController({ tools })`. */
    tool: threads.tool,
    /** `suggest_threads`, `list_threads`, `read_thread` and `message_thread`, for the same `tools`. */
    steering: threads.steering,
    /** The steering tools that return a thread's words, for `threadTextTools`. */
    threadTextTools: [LIST_THREADS_TOOL, READ_THREAD_TOOL],
    /** The main chat's mode, for `createLocusController({ modes })`. */
    supervisor: SUPERVISOR_MODE,
    /** Binds the work threads to the controller made with `tool`. */
    attach(made: AgentController) {
      attached.set(made, threads);
      attach(made);
      // Threads left working or waiting by an earlier process show as stopped.
      void threads.recover().catch(() => undefined);
    },
  };
}

/**
 * The sites the client's threads are about, in its chat store: whether a thread is a work
 * thread and the site it is tagged with, and tagging a work thread once (for the site builder's
 * `threads`). Ordinary chats are tagged by the site page instead (`kit.ts`).
 */
export function clientSiteThreads(storage: MastraStorage) {
  const memory = async () => {
    const store = await storage.getStore("memory");
    if (!store) throw new Error("site threads need a memory store");
    return store;
  };
  return {
    async of(threadId: string) {
      const thread = await (await memory()).getThreadById({ threadId });
      if (!thread) return null;
      return { work: workThreadOf(thread) !== undefined, siteId: siteOf(thread) };
    },
    async tag(threadId: string, siteId: string) {
      let tagged = false;
      // Checked inside the store's update, so two tags at once can't both win.
      await (await memory()).updateThreadMetadata({
        id: threadId,
        update: (thread) => {
          if (!workThreadOf(thread)) return undefined;
          const current = siteOf(thread);
          tagged = current === undefined || current === siteId;
          return current === undefined ? { [SITE_THREAD_KEY]: siteId } : undefined;
        },
      });
      return tagged;
    },
  };
}

/** The work threads attached to a controller, if any. */
export function workThreadsOf(controller: AgentController): WorkThreads | undefined {
  return attached.get(controller);
}
