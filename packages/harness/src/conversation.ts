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
import type { ProcessOutputResultArgs, Processor } from "@mastra/core/processors";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";

/** The conversation store for one client: a `LibSQLStore` over that client's own database. */
export type ConversationStore = MastraCompositeStore;

/** History the model sees: a token budget, not a message count (tool calls count as messages). */
export const HISTORY_TOKENS = 24_000;

export const NOT_KEPT =
  "Not kept: GoHighLevel data is only held for the request that read it. Read it again if needed.";

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

/** What a stored tool result is replaced with. Errors are ours and are kept. */
export function forgetResult(toolName: string, result: unknown): unknown {
  if (toolName === "load_skill") return result;
  if (result && typeof result === "object" && "error" in result) return result;
  const inner =
    result && typeof result === "object" && "warning" in result && "result" in result
      ? (result as { result: unknown }).result
      : result;
  // The stub holds no GHL text, so it drops the taint mark too: a later turn in the thread is
  // not tainted by what an earlier one read. (A paused run resumes from its snapshot, which
  // still has the marks, not from memory.)
  if (toolName === "query_data" && inner && typeof inner === "object" && "rowCount" in inner) {
    return { notKept: NOT_KEPT, rowCount: (inner as { rowCount: unknown }).rowCount };
  }
  return { notKept: NOT_KEPT };
}

/**
 * Runs as an output processor, before memory's own processors save the run, and replaces each
 * GHL-derived tool result in the run with a stub. The run's answer is already final by then.
 */
export class ForgetGhlData implements Processor<"locus-forget-ghl-data"> {
  readonly id = "locus-forget-ghl-data" as const;
  readonly name = "Keep GoHighLevel data out of memory";

  processOutputResult({ messages, messageList }: ProcessOutputResultArgs) {
    for (const message of messages) {
      for (const part of message.content.parts ?? []) {
        if (part.type !== "tool-invocation" || part.toolInvocation.state !== "result") continue;
        const { toolName, result } = part.toolInvocation;
        const kept = forgetResult(toolName, result);
        if (kept === result) continue;
        messageList.updateToolInvocation({
          type: "tool-invocation",
          toolInvocation: { ...part.toolInvocation, result: kept },
        });
      }
    }
    return messages;
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
