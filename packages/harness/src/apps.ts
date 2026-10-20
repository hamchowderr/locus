/**
 * Connected apps: Gmail, Slack and the other services a client connects on its Apps page,
 * offered to the agent next to GoHighLevel. GHL itself never goes through here.
 *
 * The rules, all in code:
 * - The connector is built for one client, so nothing the model says can reach another client's
 *   apps. The model names a tool and its arguments, never an account or a client.
 * - Only apps in Locus's catalog are offered: Composio's apps whose sign-in Composio manages (see
 *   `composio.ts`). The connector says whether a tool is from one (`offers`), by the tool's own
 *   metadata, and `use_app` runs nothing else.
 * - `use_app` waits for a person unless the app's own metadata marks the tool read-only and the
 *   run is not tainted. An unknown tool counts as a write.
 * - Everything an app returns is written by other people (emails, messages, events), so every
 *   `use_app` result taints the run and is screened like GHL data (see `untrusted.ts`), and
 *   memory forgets it like GHL data (see `conversation.ts`).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RunContext } from "./tools.ts";
import { isTainted, locusError } from "./untrusted.ts";

export interface AppTool {
  slug: string;
  toolkit: string;
  description: string;
  /** JSON schema of the tool's arguments, as the connector gives it. */
  inputSchema: unknown;
}

export interface AppSearch {
  /** Tools from the client's connected apps. */
  tools: AppTool[];
  /** Offered apps that could help but aren't connected; their tools can't run until they are. */
  notConnected: string[];
}

export type AppResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * One client's connected apps. Implementations bind the client when they are built (see
 * `composio.ts`); none of these methods takes a client, an account or a user.
 */
export interface AppConnector {
  search(query: string): Promise<AppSearch>;
  /** Whether the tool is from an app Locus offers, by the app's own metadata. */
  offers(slug: string): Promise<boolean>;
  /** Whether the app's own metadata marks the tool as only reading. */
  readOnly(slug: string): Promise<boolean>;
  execute(slug: string, args: Record<string, unknown>): Promise<AppResult>;
}

/** A mistake the model can fix, in Locus's own words. */
export class AppError extends Error {
  override name = "AppError";
}

/**
 * The app service refused or failed. Its message can quote the app (an email provider's
 * error, say), so it reaches the model as data, through the same screen as any app result.
 */
export class AppServiceError extends Error {
  override name = "AppServiceError";
}

export const APP_TOOL_NAMES = ["find_app_tools", "use_app"] as const;

/** `connector` is resolved per call, from the run's request context, like the GHL session. */
export function createAppTools(
  connector: AppConnector | ((requestContext?: RunContext) => Promise<AppConnector>),
) {
  const resolve = async (requestContext: RunContext | undefined) =>
    typeof connector === "function" ? connector(requestContext) : connector;

  const findAppTools = createTool({
    id: "find_app_tools",
    description:
      "Find tools in the client's connected apps (Gmail, Slack, calendars, CRMs and more) for a " +
      "task, with the arguments each takes, and the apps that could do it but aren't connected. " +
      "Use it before use_app.",
    inputSchema: z.object({ task: z.string().describe("What you want to do, in a few words") }),
    requireApproval: () => false,
    execute: async ({ task }, context) =>
      recoverable(async () => {
        const { tools, notConnected } = await (await resolve(context?.requestContext)).search(task);
        return {
          tools,
          ...(notConnected.length > 0
            ? {
                notConnected,
                note:
                  "These apps aren't connected for this client. The chat shows a Connect button for each; " +
                  "ask the person to use it (owners and admins can), then try again.",
              }
            : {}),
        };
      }),
  });

  const useApp = createTool({
    id: "use_app",
    description:
      "Run one tool from a connected app, found with find_app_tools. Anything that sends, " +
      "changes or deletes waits for a person to approve it.",
    inputSchema: z.object({
      tool: z.string().describe("Tool slug from find_app_tools, e.g. GMAIL_FETCH_EMAILS"),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
    requireApproval: async ({ tool }, ctx) => {
      try {
        if (isTainted(ctx?.requestContext) || !isSlug(tool)) return true;
        const apps = await resolve(asRunContext(ctx?.requestContext));
        if (!(await apps.offers(tool))) return true;
        return !(await apps.readOnly(tool));
      } catch {
        // Can't tell: ask.
        return true;
      }
    },
    execute: async ({ tool, arguments: args }, context) =>
      recoverable(async () => {
        const apps = await resolve(context?.requestContext);
        if (!isSlug(tool) || !(await apps.offers(tool))) {
          throw new AppError(
            `${tool} isn't from an app Locus offers. Find tools with find_app_tools.`,
          );
        }
        const result = await apps.execute(tool, args ?? {});
        return result.ok ? { data: result.data } : { error: result.error };
      }),
  });

  return { find_app_tools: findAppTools, use_app: useApp };
}

/**
 * Mastra hands a tool's `requireApproval` its run's request context as a plain record of the
 * entries, and `execute` the context itself; the resolver reads both the same way.
 */
function asRunContext(requestContext: unknown): RunContext | undefined {
  if (!requestContext || typeof requestContext !== "object") return undefined;
  const ctx = requestContext as Partial<RunContext> & Record<string, unknown>;
  return typeof ctx.get === "function" ? (ctx as RunContext) : { get: (key) => ctx[key] };
}

/** A tool slug as Composio writes them: GMAIL_SEND_EMAIL, SLACK_LIST_CHANNELS. */
function isSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(slug);
}

async function recoverable<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) return locusError(error.message);
    if (error instanceof AppServiceError) return { error: error.message };
    throw error;
  }
}
