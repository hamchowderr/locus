/**
 * The Locus agent hosted by a Mastra `AgentController`: what the chat kit talks to.
 *
 * One controller per client (one GHL location). Its storage is that client's own database, so
 * threads, messages and settings never mix clients, and every session's resource is the
 * client's (`clientResource`). The host decides which member may open a session on which client
 * (staff restrictions) before it ever reaches a controller, and passes a `session` function that
 * returns a current GHL token for that client.
 *
 * Modes share the agent and its thread:
 * - `act` (default): read and change GHL data, with Locus's approval rules.
 * - `ask`: read only; `perform_action` is not offered at all.
 * Other work (the site engine's build mode and workspace tools) adds its own modes and tools.
 *
 * Approvals: each Locus tool decides for itself whether a call waits (reads never do; deletions
 * and writes in a tainted run always do), and the controller then asks the person. Locus sets no
 * `toolCategoryResolver`, so an "always allow" answer approves only the call in front of the
 * person. A host must never set a session's `yolo` state or grant tools: either would approve
 * deletions without asking.
 *
 * The controller holds live sessions and approval gates in process memory, so it belongs in a
 * long-running server. Pending changes from plain agent runs (`conversation.ts`) are kept as
 * snapshots instead and survive any process.
 */

import type { GhlSession } from "@locus/ghl";
import type { ToolsInput } from "@mastra/core/agent";
import {
  AgentController,
  type AgentControllerMode,
  type BuiltinToolId,
} from "@mastra/core/agent-controller";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createLocusAgent, type LocusAgentConfig } from "./agent.ts";
import { type ConversationStore, clientResource } from "./conversation.ts";
import type { RunContext, ToolDeps } from "./tools.ts";

export const CONTROLLER_ID = "locus";

/** Which client each controller serves; sessions are opened through it, never named by caller. */
const clientOf = new WeakMap<AgentController, string>();
const storageOf = new WeakMap<AgentController, ConversationStore>();

/**
 * The client's own store a controller keeps its conversations in. A Mastra instance hosting the
 * controller must be given it: the controller reads threads and messages through its parent
 * Mastra's storage, and a Mastra without one falls back to an in-memory store.
 */
export function controllerStorage(controller: AgentController): ConversationStore {
  const storage = storageOf.get(controller);
  if (!storage) throw new Error("not a Locus controller");
  return storage;
}

export const ASK_TOOLS = ["load_skill", "query_data", "ask_user"];

export const LOCUS_MODES: AgentControllerMode[] = [
  {
    id: "act",
    name: "Act",
    description: "Read and change this client's GoHighLevel data.",
    metadata: { default: true },
  },
  {
    id: "ask",
    name: "Ask",
    description: "Answer questions about this client's GoHighLevel data without changing it.",
    instructions: "You are in Ask mode: read and answer only. You cannot change anything.",
    availableTools: ASK_TOOLS,
  },
];

/**
 * `submit_plan` needs a workspace filesystem and `subagent` needs configured subagent types;
 * the GHL agent has neither. Hosts that add them can turn them back on.
 */
const DISABLED_BUILTINS: BuiltinToolId[] = ["submit_plan", "subagent"];

export interface LocusControllerConfig extends Omit<ToolDeps, "session"> {
  model: MastraModelConfig;
  /** The client this controller serves. */
  locationId: string;
  /** A current location token for that client, minted server-side. Called per tool call. */
  /** Called for each GHL call, with the run's request context (see `ToolDeps.session`). */
  session: (requestContext?: RunContext) => Promise<GhlSession>;
  /** The client's own conversation store. */
  storage: ConversationStore;
  /** Further modes (for example the site engine's), after Locus's own. */
  modes?: AgentControllerMode[];
  /** Further controller tools, available to modes that list them. */
  tools?: ToolsInput;
  disableBuiltinTools?: BuiltinToolId[];
  /** Further processors for the modes and tools added here (see `LocusAgentConfig`). */
  processors?: LocusAgentConfig["processors"];
  /** Tools added here whose results hold no GHL data (see `LocusAgentConfig`). */
  keepResults?: LocusAgentConfig["keepResults"];
}

export async function createLocusController({
  model,
  locationId,
  session,
  storage,
  modes = [],
  tools,
  disableBuiltinTools = DISABLED_BUILTINS,
  processors,
  keepResults,
  ...deps
}: LocusControllerConfig): Promise<AgentController> {
  const resourceId = clientResource({ token: "", tokenKind: "location", locationId });
  const checkedSession = async (requestContext?: RunContext) => {
    const current = await session(requestContext);
    // A wiring mistake here would act on the wrong client; fail before any request is sent.
    if (current.tokenKind !== "location" || current.locationId !== locationId) {
      throw new Error(`session is not for client ${locationId}`);
    }
    return current;
  };
  const agent = createLocusAgent({
    ...deps,
    model,
    session: checkedSession,
    storage,
    ...(processors ? { processors } : {}),
    ...(keepResults ? { keepResults } : {}),
  });
  const controller = new AgentController({
    id: CONTROLLER_ID,
    agent,
    storage,
    resourceId,
    modes: [...LOCUS_MODES, ...modes],
    defaultModeId: "act",
    disableBuiltinTools,
    ...(tools ? { tools } : {}),
  });
  await controller.init();
  clientOf.set(controller, locationId);
  storageOf.set(controller, storage);
  return controller;
}

/**
 * Opens (or returns the live) session for one member on the controller's client. The resource
 * is always that client's; the member only picks the scope, so two members on one client get
 * separate live sessions over the same client's threads. Call it only after checking the
 * member may act on this client.
 */
export async function openClientSession(
  controller: AgentController,
  { memberId, threadId }: { memberId: string; threadId?: string },
) {
  const locationId = clientOf.get(controller);
  if (!locationId) throw new Error("not a Locus controller");
  return controller.createSession({
    resourceId: clientResource({ token: "", tokenKind: "location", locationId }),
    scope: `member:${memberId}`,
    ...(threadId ? { threadId } : {}),
  });
}
