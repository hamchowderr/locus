/**
 * The main chat's tool calls in a few plain words each, for its step rows. The names and
 * arguments are the harness's tools (packages/harness/src/tools.ts and apps.ts) and the
 * tools that steer threads (packages/agent-api/src/mastra/lib/work-thread-steering.ts).
 */

import { type BuilderStep, callFailed } from "./builder-steps";

type Call = { name: string; args: unknown };
type Result = { result?: unknown; isError?: boolean } | undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** "contacts.create-contact" → its area, "contacts", and its action, "create contact". */
function operation(id: unknown): { area?: string | undefined; action?: string | undefined } {
  const text = str(id);
  if (!text) return {};
  const [area, action] = text.split(".", 2);
  const words = (s: string | undefined) => s?.replace(/[-_]+/g, " ").trim() || undefined;
  return { area: words(area), action: words(action) };
}

/** Words joined as people say them: "a", "a and b", "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** An app tool's slug, "GMAIL_SEND_EMAIL", as "Gmail: send email". */
function appTool(slug: unknown): string | undefined {
  const text = str(slug);
  if (!text) return undefined;
  const [app, ...rest] = text.toLowerCase().split("_");
  const name = app ? app[0]?.toUpperCase() + app.slice(1) : "";
  return rest.length ? `${name}: ${rest.join(" ")}` : name;
}

function label(call: Call): string | null {
  const a = (call.args ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "load_skill":
      return str(a.category) ? `Read the ${str(a.category)} guide` : "Read a guide";
    case "query_data": {
      const sources = Array.isArray(a.sources) ? a.sources : [];
      const areas = [
        ...new Set(
          sources
            .map((s) => operation((s as { operation?: unknown } | null)?.operation).area)
            .filter((x): x is string => Boolean(x)),
        ),
      ];
      return areas.length ? `Looked up ${list(areas)}` : "Looked up data in HighLevel";
    }
    case "perform_action": {
      const { action } = operation(a.operation);
      return action ? action[0]?.toUpperCase() + action.slice(1) : "Made a change in HighLevel";
    }
    case "find_app_tools":
      return "Looked for the right app";
    case "use_app":
      return appTool(a.tool) ?? "Used a connected app";
    case "list_threads":
      return "Checked on the threads";
    case "read_thread":
      return "Read a thread";
    case "message_thread":
      return "Messaged a thread";
  }
  return null;
}

/** A main-chat tool call as a step row, or null when it isn't one of the harness's tools. */
export function chatStep(call: Call, result: Result): BuilderStep | null {
  const text = label(call);
  if (!text) return null;
  if (!callFailed(result)) return { label: text };
  const r = result?.result as { error?: unknown; message?: unknown } | null | undefined;
  const said = str(r?.error) ?? str(r?.message);
  return said && said.length <= 200
    ? { label: text, detail: said, failed: true }
    : { label: text, failed: true };
}

/**
 * Calls the main chat shows in full: an app search that found apps to connect, whose card
 * offers a Connect button.
 */
export function chatShowsInFull(call: Call, result: Result): boolean {
  if (call.name !== "find_app_tools") return false;
  const notConnected = (result?.result as { notConnected?: unknown } | undefined)?.notConnected;
  return Array.isArray(notConnected) && notConnected.length > 0;
}
