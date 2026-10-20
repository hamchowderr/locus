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
 * - A report carries the thread's own words into the main chat, so what reads like
 *   instructions in it is withheld, as in any GHL data.
 * - Its sessions get no grants: Locus's approval rules hold there as everywhere.
 */

import { isTainted, withholdInstructions } from "@locus/harness";
import type { AgentController } from "@mastra/core/agent-controller";
import type { MastraStorage } from "@mastra/core/storage";
import { createWorkThreads, type WorkThreads } from "./mastra/lib/work-threads.ts";

const attached = new WeakMap<AgentController, WorkThreads>();

/** Work threads over one client's store, to attach to that client's controller once made. */
export function clientWorkThreads(storage: MastraStorage) {
  let attach!: (controller: AgentController) => void;
  const controller = new Promise<AgentController>((resolve) => {
    attach = resolve;
  });
  const threads = createWorkThreads({
    getController: () => controller,
    storage,
    requireApproval: isTainted,
    startsUntrusted: isTainted,
    screenReport: (text) => {
      const screened = withholdInstructions(text).value;
      return typeof screened === "string" ? screened : "";
    },
  });
  return {
    /** The `start_thread` tool, for `createLocusController({ tools })`. */
    tool: threads.tool,
    /** Binds the work threads to the controller made with `tool`. */
    attach(made: AgentController) {
      attached.set(made, threads);
      attach(made);
      // Threads left working or waiting by an earlier process show as stopped.
      void threads.recover().catch(() => undefined);
    },
  };
}

/** The work threads attached to a controller, if any. */
export function workThreadsOf(controller: AgentController): WorkThreads | undefined {
  return attached.get(controller);
}
