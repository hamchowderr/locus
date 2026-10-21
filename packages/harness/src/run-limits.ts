/**
 * When an agent run stops on its own. The agent controller lets a run take up to 1000 model
 * steps and stops it only when the person's connection drops, so a model that keeps retrying a
 * broken call spends credits until someone notices. These conditions end a run sooner; they
 * reach every run, resumed ones too, through the agent's default `stopWhen`.
 */

/** The part of a finished step these conditions read. */
interface Step {
  content?: readonly { type: string; toolName?: string; output?: unknown }[];
}

/** A Mastra `stopWhen` condition: true ends the run after the current step. */
type StopCondition = (options: { steps: readonly Step[] }) => boolean;

/** The most model steps one run may take. Building a whole site stays well under it. */
export const RUN_STEP_LIMIT = 150;

/** How many steps in a row may fail the same tool before the run stops. */
export const REPEATED_FAILURE_LIMIT = 3;

/** Whether a tool result is a failure: a thrown error, bad arguments, or an `{ error }` result. */
function failed(part: { type: string; output?: unknown }): boolean {
  if (part.type === "tool-error") return true;
  if (part.type !== "tool-result") return false;
  const output = part.output as { type?: string; value?: unknown } | undefined;
  if (!output || typeof output.type !== "string") return false;
  if (output.type.startsWith("error")) return true;
  const value = output.value;
  return (
    output.type === "json" &&
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    Boolean((value as { error: unknown }).error)
  );
}

/** The tools that failed in a step where every call failed; empty when any call worked. */
function failedTools(step: Step): Set<string> {
  const results = (step.content ?? []).filter(
    (part) => part.type === "tool-result" || part.type === "tool-error",
  );
  if (results.length === 0 || !results.every(failed)) return new Set();
  return new Set(results.map((part) => part.toolName ?? ""));
}

/** Stops a run once the same tool has failed in `limit` steps in a row with nothing working. */
export function stopOnRepeatedFailures(limit = REPEATED_FAILURE_LIMIT): StopCondition {
  return ({ steps }) => {
    if (steps.length < limit) return false;
    const [first, ...rest] = steps.slice(-limit).map(failedTools);
    if (!first) return false;
    return [...first].some((tool) => rest.every((names) => names.has(tool)));
  };
}

/** Stops a run at `limit` steps. */
export function stopAtStepLimit(limit = RUN_STEP_LIMIT): StopCondition {
  return ({ steps }) => steps.length >= limit;
}

export const RUN_STOP_CONDITIONS: StopCondition[] = [stopAtStepLimit(), stopOnRepeatedFailures()];
