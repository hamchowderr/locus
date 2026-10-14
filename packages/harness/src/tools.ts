import {
  GhlError,
  type GhlRateLimiter,
  type GhlSession,
  GhlUsageError,
  sharedRateLimiter,
} from "@locus/ghl";
import { catalog } from "@locus/skills";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ActionError, loadSkill, needsApproval, performAction } from "./actions.ts";
import { QueryError, type QueryLimits, runQuery } from "./query-data.ts";
import type { WriteGuard } from "./test-mode.ts";
import { isTainted } from "./untrusted.ts";

export interface ToolDeps {
  /**
   * Resolved server-side from the signed-in user; the model can never change it. A function is
   * called for each tool call, so a long-lived host (the agent controller) always uses a
   * current token.
   */
  session: GhlSession | (() => Promise<GhlSession>);
  fetch?: typeof fetch;
  limits?: Partial<QueryLimits>;
  /** Test-write mode for a real client's account; see `test-mode.ts`. */
  writeGuard?: WriteGuard;
  /** The client's GHL burst budget. Defaults to the one shared by the whole process. */
  rateLimiter?: GhlRateLimiter;
}

const categories = catalog.map((skill) => skill.category) as [string, ...string[]];

const requestInput = z
  .object({
    path: z.record(z.string(), z.string()).optional().describe("Path parameters by name"),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Query parameters by name"),
    body: z.record(z.string(), z.unknown()).optional().describe("JSON request body"),
  })
  .describe("Never include locationId, altId, altType or companyId — the session supplies them");

/**
 * The three tools. They close over the session, so every call acts on the signed-in user's
 * client and nothing the model says can point them elsewhere.
 */
export function createLocusTools(deps: ToolDeps) {
  const rateLimiter = deps.rateLimiter ?? sharedRateLimiter;
  const session = async () => (typeof deps.session === "function" ? deps.session() : deps.session);
  const loadSkillTool = createTool({
    id: "load_skill",
    description:
      "Load the guidance and operation index for one GoHighLevel area before using its " +
      "operations. Call it for every area a task touches.",
    inputSchema: z.object({ category: z.enum(categories) }),
    // Each tool decides its own approval, so a host that asks for approval of every tool call
    // (the AgentController does) still lets reads through.
    requireApproval: () => false,
    execute: async ({ category }) => recoverable(() => loadSkill(category)),
  });

  const queryDataTool = createTool({
    id: "query_data",
    description:
      "Read GoHighLevel data and answer questions about it with SQL, in one call. List the " +
      "sources (read operations from a loaded skill), each becomes a table named by `as`. " +
      "`forEach` runs a source once per distinct value of a column from an earlier source; " +
      "each row then has a `_key` column holding that value. Paging is automatic. Do all " +
      "counting, filtering and arithmetic in the SQL (SQLite dialect; nested objects are JSON " +
      "text, use json_extract). Check `sources[].complete` before treating a result as total.",
    inputSchema: z.object({
      sources: z
        .array(
          z.object({
            as: z.string().describe("Table name"),
            operation: z.string().describe("Operation id, e.g. opportunities.search-opportunity"),
            params: requestInput.optional(),
            rowsField: z
              .string()
              .optional()
              .describe("Response field holding the rows, if the response has several lists"),
            forEach: z
              .object({ from: z.string(), column: z.string(), param: z.string() })
              .optional(),
          }),
        )
        .min(1),
      sql: z.string().describe("One SELECT over the source tables"),
    }),
    requireApproval: () => false,
    execute: async (spec) =>
      recoverable(async () =>
        runQuery(spec, {
          session: await session(),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.limits ? { limits: deps.limits } : {}),
          rateLimiter,
        }),
      ),
  });

  const performActionTool = createTool({
    id: "perform_action",
    description:
      "Change data in GoHighLevel with one write operation from a loaded skill. Deletions wait " +
      "for a person to approve them.",
    inputSchema: z.object({
      operation: z.string().describe("Operation id, e.g. contacts.create-contact"),
      params: requestInput.optional(),
    }),
    // A run that read untrusted content (see `untrusted.ts`) approves every write.
    requireApproval: ({ operation }, ctx) =>
      isTainted(ctx?.requestContext) || needsApproval(operation),
    execute: async (input) =>
      recoverable(async () =>
        performAction(input, {
          session: await session(),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.writeGuard ? { writeGuard: deps.writeGuard } : {}),
          rateLimiter,
        }),
      ),
  });

  return {
    load_skill: loadSkillTool,
    query_data: queryDataTool,
    perform_action: performActionTool,
  };
}

/**
 * Mistakes the model can fix come back as data so it can correct itself. Anything else —
 * a bug, an outage — is thrown.
 */
async function recoverable<T>(run: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof QueryError ||
      error instanceof ActionError ||
      error instanceof GhlUsageError ||
      error instanceof GhlError
    ) {
      return { error: error.message };
    }
    throw error;
  }
}

/**
 * Asks a call's own tool whether it will wait for a person, using the same rule the agent
 * applies before running it. An unknown tool counts as waiting.
 */
export function waitsForApproval(tools: Record<string, unknown>) {
  return async (call: { toolName: string; args: unknown }, requestContext: unknown) => {
    const tool = tools[call.toolName] as
      | { requireApproval?: boolean | ((input: unknown, ctx: unknown) => unknown) }
      | undefined;
    if (!tool) return true;
    const rule = tool.requireApproval;
    if (typeof rule === "function") return Boolean(await rule(call.args, { requestContext }));
    return rule === true;
  };
}
