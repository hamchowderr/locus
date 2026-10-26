/**
 * Conversations that outlive a request: message history, and approvals a person gives later.
 *
 * Both live in the client's own database (`storage`, a `LibSQLStore` over that client's Turso
 * database), never in the control database. The memory resource is derived from the session,
 * so a thread can only ever be read, continued or approved for the client that owns it.
 *
 * GHL data is never cached beyond a request (`.claude/rules/tenancy.md`), so what is saved is
 * the conversation: the person's messages, the agent's answers and which operations it called.
 * Tool results are replaced by `ForgetGhlData` before memory saves them; on a later turn the
 * agent reads GHL again rather than trusting an old copy.
 */

import type { GhlSession } from "@locus/ghl";
import type { Agent } from "@mastra/core/agent";
import type {
  ProcessOutputResultArgs,
  ProcessOutputStepArgs,
  Processor,
  ToolCallInfo,
} from "@mastra/core/processors";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import { APPROVED } from "./tools.ts";
import { TAINT_MARK } from "./untrusted.ts";

/** The conversation store for one client: a `LibSQLStore` over that client's own database. */
export type ConversationStore = MastraCompositeStore;

/** History the model sees: a token budget, not a message count (tool calls count as messages). */
export const HISTORY_TOKENS = 24_000;

/**
 * The stub's text. It replaces every forgotten result, not only GHL reads (site-builder tools,
 * writes, failures), and serves later turns too. Told only that a result was gone, a model
 * concluded it had invented the contacts it had just read (`apps/agent/fixtures/recorded/ask-back`),
 * so the note says the result was real. A run that resumed after an approval saw its own read
 * blanked and said it had drafted a reply before reading the conversation, so the note also says
 * the later steps were taken with the result in view. Told that, a resumed run still decided it
 * had made up the summary it wrote from the read, and took it back (staging, 2026-10-26), so the
 * note also says outright that a missing result is no sign of that. It still sends the model
 * back to GHL for current data, and to say so when that differs.
 */
export const NOT_KEPT =
  "Not kept: this tool really ran and returned a result, which was removed afterwards because " +
  "it may hold data from GoHighLevel or a connected app, and that is not stored. You had the " +
  "whole result when you took the steps after it, so what you did and said then was based on " +
  "it. Its absence now is no sign that you did not see it or that you made up what you said " +
  "from it. It may have changed since: read it again before you rely on its details, and if " +
  "the new read differs from what you said, say so.";

export function createLocusMemory(storage: ConversationStore): Memory {
  return new Memory({
    storage,
    options: {
      messageHistory: { maxTokens: HISTORY_TOKENS },
      // Both of these call a model on their own; neither is worth credits yet.
      generateTitle: false,
      semanticRecall: false,
    },
  });
}

/** The memory resource for the session's client. Never taken from a request. */
export function clientResource(session: GhlSession): string {
  if (session.tokenKind !== "location" || !session.locationId) {
    throw new Error("conversations belong to one client: the session needs a location token");
  }
  return `client:${session.locationId}`;
}

/**
 * What a stored tool result is replaced with. Results are forgotten unless the tool is named in
 * `keep`: `load_skill` (our own text) always is, and a feature names its own tools whose results
 * can never hold GHL data. A GHL error can quote GHL data (a duplicate contact's email), so
 * errors keep only that they failed.
 * `keepTaint` keeps the untrusted-content mark, so a paused run that resumes from memory is
 * still tainted (see `untrusted.ts`); a finished run's stubs drop it, so a later turn in the
 * thread is not tainted by what an earlier one read.
 */
export function forgetResult(
  toolName: string,
  result: unknown,
  { keepTaint = false, keep = [] }: { keepTaint?: boolean; keep?: readonly string[] } = {},
): unknown {
  if (toolName === "load_skill" || keep.includes(toolName)) return result;
  if (!result || typeof result !== "object") return { notKept: NOT_KEPT };
  const wrapped = "warning" in result && "result" in result;
  const inner = wrapped ? (result as { result: unknown }).result : result;
  const taint =
    keepTaint && "taint" in result && result.taint === TAINT_MARK ? { taint: TAINT_MARK } : {};
  if (inner && typeof inner === "object" && "error" in inner) {
    return { notKept: NOT_KEPT, failed: true, ...taint };
  }
  // Our own words, not GHL's: a later turn still knows the change was approved and made.
  const approved =
    inner && typeof inner === "object" && "approved" in inner && inner.approved === APPROVED
      ? { approved: APPROVED }
      : {};
  if (toolName === "query_data" && inner && typeof inner === "object" && "rowCount" in inner) {
    return { notKept: NOT_KEPT, rowCount: (inner as { rowCount: unknown }).rowCount, ...taint };
  }
  return { notKept: NOT_KEPT, ...approved, ...taint };
}

/** Whether a tool call will wait for a person before it runs, by the tool's own rule. */
export type WaitsForApproval = (call: ToolCallInfo, requestContext: unknown) => Promise<boolean>;

/**
 * Replaces each GHL-derived tool result in a run with a stub, before memory saves the run:
 *
 * - `processOutputResult`: when the run finishes, the answer is final.
 * - `processOutputStep`: when a step is about to stop for an approval. A paused run is saved
 *   as it stands and may never be decided, so its data must go now. The run resumes without
 *   it and reads GHL again if it needs to.
 */
export class ForgetGhlData implements Processor<"locus-forget-ghl-data"> {
  readonly id = "locus-forget-ghl-data" as const;
  readonly name = "Keep GoHighLevel data out of memory";

  readonly #waitsForApproval: WaitsForApproval;
  readonly #keep: readonly string[];

  /** `keep`: tools whose results hold no GHL data and are stored as they are. */
  constructor(waitsForApproval: WaitsForApproval, keep: readonly string[] = []) {
    this.#waitsForApproval = waitsForApproval;
    this.#keep = keep;
  }

  async processOutputStep({
    messages,
    messageList,
    toolCalls,
    requestContext,
  }: ProcessOutputStepArgs) {
    for (const call of toolCalls ?? []) {
      if (await this.#waitsForApproval(call, requestContext)) {
        forgetAll(messages, messageList, true, this.#keep);
        break;
      }
    }
    return messages;
  }

  processOutputResult({ messages, messageList }: ProcessOutputResultArgs) {
    forgetAll(messages, messageList, false, this.#keep);
    return messages;
  }
}

/** Stubs every result `forgetResult` doesn't keep, with any model output stored for it. */
export function forgetAll(
  messages: ProcessOutputResultArgs["messages"],
  messageList: ProcessOutputResultArgs["messageList"],
  keepTaint: boolean,
  keep: readonly string[],
) {
  for (const message of messages) {
    for (const part of message.content.parts ?? []) {
      if (part.type !== "tool-invocation" || part.toolInvocation.state !== "result") continue;
      const { toolName, result } = part.toolInvocation;
      const kept = forgetResult(toolName, result, { keepTaint, keep });
      if (kept === result) continue;
      messageList.updateToolInvocation({
        type: "tool-invocation",
        toolInvocation: { ...part.toolInvocation, result: kept },
        // A tool's `toModelOutput` (e.g. a picture for the model) is stored beside the result
        // and sent in its place on later turns; the stub replaces that too.
        providerMetadata: { mastra: { modelOutput: null } },
      });
    }
  }
}

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Changes in this client's thread waiting for a person to approve or decline them. */
export async function pendingApprovals(
  agent: Agent,
  session: GhlSession,
  threadId: string,
): Promise<PendingApproval[]> {
  const { runs } = await agent.listSuspendedRuns({
    threadId,
    resourceId: clientResource(session),
  });
  return runs.flatMap((run) =>
    run.toolCalls.flatMap(({ requiresApproval, toolCallId, toolName, args }) =>
      requiresApproval && toolCallId && toolName
        ? [{ runId: run.runId, toolCallId, toolName, args }]
        : [],
    ),
  );
}

export class ApprovalError extends Error {
  override name = "ApprovalError";
}

/**
 * Approves or declines one pending change. Only a change pending in this client's thread can be
 * decided: the run is looked up through the session, never taken from the caller as is.
 */
export async function decideApproval(
  agent: Agent,
  session: GhlSession,
  decision: { threadId: string; toolCallId: string; approve: boolean; reason?: string },
) {
  const pending = await pendingApprovals(agent, session, decision.threadId);
  const call = pending.find((p) => p.toolCallId === decision.toolCallId);
  if (!call) throw new ApprovalError("no change with that id is waiting for approval here");
  const target = { runId: call.runId, toolCallId: call.toolCallId };
  return decision.approve
    ? agent.approveToolCallGenerate(target)
    : agent.declineToolCallGenerate({
        ...target,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
}
