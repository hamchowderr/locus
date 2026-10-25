/**
 * `perform_action` and `load_skill` as plain functions. The Mastra tools in `tools.ts` are thin
 * wrappers over these, so the rules here are tested without a model in the loop.
 */

import { type GhlRateLimiter, type GhlRequestInput, type GhlSession, ghlRequest } from "@locus/ghl";
import { isRead, operationById, type SkillOperation, skillDocs } from "@locus/skills";
import type { WriteGuard } from "./test-mode.ts";

export class ActionError extends Error {
  override name = "ActionError";
}

export interface ActionDeps {
  session: GhlSession;
  fetch?: typeof fetch;
  rateLimiter?: GhlRateLimiter | undefined;
  /** Set when writing to a real client's account in testing; see `test-mode.ts`. */
  writeGuard?: WriteGuard | undefined;
}

/** The write path. Reads go through `query_data`; this only changes data. */
export async function performAction(
  input: { operation: string; params?: GhlRequestInput | undefined },
  deps: ActionDeps,
): Promise<unknown> {
  const op = writeOperation(input.operation);
  const params = deps.writeGuard
    ? deps.writeGuard.check(op, input.params ?? {})
    : (input.params ?? {});
  const result = await ghlRequest(op, deps.session, params, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    rateLimiter: deps.rateLimiter,
  });
  deps.writeGuard?.record(op, params, result);
  return result;
}

/**
 * Writes that reach a person outside the agency: a message to a contact can't be taken back.
 * Scheduling one is no different, since it goes out with nobody watching.
 */
export const SENDS_TO_CONTACT: ReadonlySet<string> = new Set(["conversations.send-a-new-message"]);

/**
 * Whether a write needs a person to approve it before it runs. Deletions and messages to a
 * contact always do. This is a rule in code, not a request in the prompt.
 */
export function needsApproval(operationId: string): boolean {
  const op = operationById(operationId);
  return op === undefined || op.method === "DELETE" || SENDS_TO_CONTACT.has(operationId);
}

export function writeOperation(id: string): SkillOperation {
  const op = operationById(id);
  if (!op) throw new ActionError(`unknown operation "${id}"`);
  if (isRead(op)) throw new ActionError(`${op.id} only reads — use query_data`);
  return op;
}

export function loadSkill(category: string): { skill: string; operations: string } {
  const docs = skillDocs(category);
  if (!docs) throw new ActionError(`unknown skill "${category}"`);
  return docs;
}
