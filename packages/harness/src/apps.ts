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
 * - Owners and admins choose, per app, how the chat may use it (`AppAccess`, on the Apps page):
 *   - `allow`: everything runs unasked, except a tool that deletes;
 *   - `ask_changes` (the default): reads run unasked, anything else waits for a person;
 *   - `ask`: every call waits;
 *   - `off`: `find_app_tools` hides the app's tools and `use_app` refuses them.
 *   The setting is read on every call, so a change takes effect on the chat's next step.
 * - Whatever the setting, `use_app` waits for a person once the run is tainted, for a tool the
 *   connector won't vouch for, and whenever it can't tell. An unknown tool counts as a write.
 * - Everything an app returns is written by other people (emails, messages, events), so every
 *   `use_app` result taints the run and is screened like GHL data (see `untrusted.ts`), and
 *   memory forgets it like GHL data (see `conversation.ts`).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RunContext } from "./tools.ts";
import { hasRefusedBrief, isTainted, locusError } from "./untrusted.ts";

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

/** How the chat may use one connected app. See the top of this file. */
export const APP_ACCESS = ["allow", "ask_changes", "ask", "off"] as const;
export type AppAccess = (typeof APP_ACCESS)[number];
/** A newly connected app: reads run, anything else waits for a person. */
export const DEFAULT_APP_ACCESS: AppAccess = "ask_changes";
/** The client's settings by toolkit slug; apps it doesn't name use `DEFAULT_APP_ACCESS`. */
export type AppAccessSettings = Readonly<Record<string, string>>;

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
  /**
   * The tool's app (toolkit slug, lower case), by the tool's own metadata; null when it isn't
   * from an app Locus offers.
   */
  toolkit(slug: string): Promise<string | null>;
  /** Whether the tool deletes, by the app's own metadata or the tool's name. Unsure means yes. */
  deletes(slug: string): Promise<boolean>;
  /**
   * The client's settings for its apps (Apps page), read fresh on every call. Without it,
   * every app has the default.
   */
  access?(): Promise<AppAccessSettings>;
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
        const apps = await resolve(context?.requestContext);
        const found = await apps.search(task);
        const settings = (await apps.access?.()) ?? {};
        // An app turned off is hidden: the model never sees its tools.
        const turnedOff = new Set<string>();
        const tools = found.tools.filter((tool) => {
          const off = accessOf(settings, tool.toolkit) === "off";
          if (off) turnedOff.add(tool.toolkit);
          return !off;
        });
        const { notConnected } = found;
        return {
          tools,
          ...(turnedOff.size > 0
            ? {
                turnedOff: [...turnedOff],
                turnedOffNote:
                  "These apps are connected but turned off: on the Connectors page by an owner or " +
                  "admin, or for this chat in the composer's + menu. Their tools can't be used " +
                  "until they're turned back on.",
              }
            : {}),
          ...(notConnected.length > 0
            ? {
                notConnected,
                note:
                  "These apps aren't connected for this client. If a person is in the chat, they'll see a " +
                  "Connect button for each (owners and admins can use it); ask them to connect, then try again.",
              }
            : {}),
        };
      }),
  });

  const useApp = createTool({
    id: "use_app",
    description:
      "Run one tool from a connected app, found with find_app_tools. Depending on how the app " +
      "is set up on the Apps page, the call may wait for a person to approve it.",
    inputSchema: z.object({
      tool: z.string().describe("Tool slug from find_app_tools, e.g. GMAIL_FETCH_EMAILS"),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
    requireApproval: async ({ tool }, ctx) => {
      try {
        // A run that read untrusted content, or holds a refused suggestion's brief, asks first.
        if (isTainted(ctx?.requestContext) || hasRefusedBrief(ctx?.requestContext)) return true;
        if (!isSlug(tool)) return true;
        const apps = await resolve(asRunContext(ctx?.requestContext));
        const toolkit = await apps.toolkit(tool);
        if (!toolkit || !(await apps.offers(tool))) return true;
        switch (accessOf((await apps.access?.()) ?? {}, toolkit)) {
          case "allow":
            return await apps.deletes(tool);
          case "ask_changes":
            return !(await apps.readOnly(tool));
          default:
            // `ask`, and `off` too: `execute` refuses an app turned off, and asking first means
            // it can't slip through if the app is turned back on meanwhile.
            return true;
        }
      } catch {
        // Can't tell: ask.
        return true;
      }
    },
    execute: async ({ tool, arguments: args }, context) =>
      recoverable(async () => {
        const apps = await resolve(context?.requestContext);
        const toolkit = isSlug(tool) ? await apps.toolkit(tool) : null;
        if (!toolkit || !(await apps.offers(tool))) {
          throw new AppError(
            `${tool} isn't from an app Locus offers. Find tools with find_app_tools.`,
          );
        }
        if (accessOf((await apps.access?.()) ?? {}, toolkit) === "off") {
          throw new AppError(
            `${toolkit} is turned off, on the Connectors page or for this chat, so its tools ` +
              "can't run until it's turned back on.",
          );
        }
        const result = await apps.execute(tool, args ?? {});
        return result.ok ? { data: result.data } : { error: result.error };
      }),
  });

  return { find_app_tools: findAppTools, use_app: useApp };
}

/** The app's setting; one Locus doesn't know (a newer build wrote it, say) asks every time. */
export function accessOf(settings: AppAccessSettings, toolkit: string): AppAccess {
  const key = toolkit.toLowerCase();
  const value = Object.hasOwn(settings, key) ? settings[key] : undefined;
  if (value === undefined) return DEFAULT_APP_ACCESS;
  return (APP_ACCESS as readonly string[]).includes(value) ? (value as AppAccess) : "ask";
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
