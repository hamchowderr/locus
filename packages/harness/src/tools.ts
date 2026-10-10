import { GhlError, type GhlSession, GhlUsageError } from "@locus/ghl";
import { catalog } from "@locus/skills";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ActionError, loadSkill, needsApproval, performAction } from "./actions.ts";
import { QueryError, type QueryLimits, runQuery } from "./query-data.ts";
import type { WriteGuard } from "./test-mode.ts";

export interface ToolDeps {
  /** Resolved server-side from the signed-in user. The model can never change it. */
  session: GhlSession;
  fetch?: typeof fetch;
  limits?: Partial<QueryLimits>;
  /** Test-write mode for a real client's account; see `test-mode.ts`. */
  writeGuard?: WriteGuard;
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
  const loadSkillTool = createTool({
    id: "load_skill",
    description:
      "Load the guidance and operation index for one GoHighLevel area before using its " +
      "operations. Call it for every area a task touches.",
    inputSchema: z.object({ category: z.enum(categories) }),
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
    execute: async (spec) =>
      recoverable(() =>
        runQuery(spec, {
          session: deps.session,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.limits ? { limits: deps.limits } : {}),
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
    requireApproval: ({ operation }) => needsApproval(operation),
    execute: async (input) =>
      recoverable(() =>
        performAction(input, {
          session: deps.session,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.writeGuard ? { writeGuard: deps.writeGuard } : {}),
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
