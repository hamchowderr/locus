import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createLocusTools, type ToolDeps } from "./tools.ts";

/**
 * Deliberately short and identical on every request, so it caches. Nothing GHL-specific lives
 * here: domain knowledge arrives through `load_skill`, and every rule that must always hold is
 * enforced in the tools' code rather than asked for in prose.
 */
export const INSTRUCTIONS = `You operate GoHighLevel accounts for a marketing agency.

Work in three steps:
1. load_skill for each area the task touches, before using its operations.
2. query_data to read. Put every count, filter, sum and comparison in its SQL — never work out
   numbers yourself. If a source reports complete: false, say the answer may be partial.
3. perform_action to change anything, one operation at a time.

When a tool returns { error }, read it, fix the call and try again. Never invent ids: find them
with query_data. Answer briefly and say what you changed.`;

export interface LocusAgentConfig extends ToolDeps {
  model: MastraModelConfig;
}

/** One agent per request: its tools are bound to that request's session. */
export function createLocusAgent({ model, ...deps }: LocusAgentConfig) {
  return new Agent({
    id: "locus",
    name: "Locus",
    instructions: INSTRUCTIONS,
    model,
    tools: createLocusTools(deps),
  });
}
