/**
 * When an agent run stops on its own. The agent controller lets a run take up to 1000 model
 * steps and stops it only when the person's connection drops, so a model that keeps retrying a
 * broken call spends credits until someone notices. These conditions end a run sooner; they
 * reach every run, resumed ones too, through the agent's default `stopWhen`. Each counts the
 * steps since the run last started or resumed (after an approval, say).
 *
 * A run stopped here ends right after its last tool step, with no closing message from the
 * model; the person can send another message to go on.
 */

/** The part of a finished step these conditions read. */
interface Step {
  content?: readonly { type: string; toolName?: string; input?: unknown; output?: unknown }[];
  finishReason?: string;
}

/** A Mastra `stopWhen` condition: true ends the run after the current step. */
type StopCondition = (options: { steps: readonly Step[] }) => boolean;

/**
 * The most model steps one run may take. A first multi-page site build (skills, brief, a write
 * per file, images, a few check-and-fix rounds) needs well under half of this.
 */
export const RUN_STEP_LIMIT = 300;

/**
 * How many steps in a row may fail the same call (same tool, same input) before the run stops.
 * The builder is told to stop and explain after two; this is the backstop when it doesn't.
 */
export const REPEATED_FAILURE_LIMIT = 3;

const hasError = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  Boolean((value as { error: unknown }).error);

/**
 * Whether a tool result is a failure: a thrown error, bad arguments, or an `{ error }` result,
 * including one the GHL screen has wrapped as `{ result: { error } }`.
 */
function failed(output: unknown): boolean {
  const { type, value } = (output ?? {}) as { type?: unknown; value?: unknown };
  if (typeof type !== "string") return false;
  if (type.startsWith("error")) return true;
  if (type !== "json" || typeof value !== "object" || value === null) return false;
  return hasError(value) || hasError((value as { result?: unknown }).result);
}

/** JSON with sorted keys, so one call's input always reads the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The calls that failed in a step where every call failed; empty when any call worked. */
function failedCalls(step: Step): Set<string> {
  const results = (step.content ?? []).filter((part) => part.type === "tool-result");
  if (results.length === 0 || !results.every((part) => failed(part.output))) return new Set();
  return new Set(results.map((part) => `${part.toolName}:${stable(part.input)}`));
}

/** How a failed result failed, in words that hold none of its data. */
function failureKind(output: unknown): string {
  const { type, value } = (output ?? {}) as { type?: string; value?: unknown };
  if (type?.startsWith("error")) return "threw an error";
  if (typeof value === "object" && value !== null && "validationErrors" in value) {
    return "got input it couldn't read";
  }
  return "returned an error";
}

/**
 * Writes why a run stopped to the server log. Only tool names and sizes: inputs and errors can
 * hold GHL data, and logs keep none.
 */
export type StopLog = (message: string) => void;
const warn: StopLog = (message) => console.warn(message);

/** Stops a run once the same call has failed in `limit` steps in a row with nothing working. */
export function stopOnRepeatedFailures(
  limit = REPEATED_FAILURE_LIMIT,
  log: StopLog = warn,
): StopCondition {
  return ({ steps }) => {
    if (steps.length < limit) return false;
    const [first, ...rest] = steps.slice(-limit).map(failedCalls);
    if (!first) return false;
    const call = [...first].find((key) => rest.every((calls) => calls.has(key)));
    if (!call) return false;
    const toolName = call.slice(0, call.indexOf(":"));
    const part = steps
      .at(-1)
      ?.content?.find((p) => p.type === "tool-result" && p.toolName === toolName);
    log(
      `Agent run stopped: ${toolName} ${failureKind(part?.output)} ${limit} steps in a row ` +
        `(input ${stable(part?.input).length} characters)`,
    );
    return true;
  };
}

/** Stops a run at `limit` steps, not counting steps Mastra retried. */
export function stopAtStepLimit(limit = RUN_STEP_LIMIT, log: StopLog = warn): StopCondition {
  return ({ steps }) => {
    if (steps.filter((step) => step.finishReason !== "retry").length < limit) return false;
    log(`Agent run stopped: it reached the ${limit}-step limit`);
    return true;
  };
}

export const RUN_STOP_CONDITIONS: StopCondition[] = [stopAtStepLimit(), stopOnRepeatedFailures()];
