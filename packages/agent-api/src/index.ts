/**
 * The agent API: the HTTP surface the chat kit (`@mastra/client-js`'s agent-controller client)
 * talks to, in front of one Locus `AgentController` per client.
 *
 * Mastra's own controller routes take the client from the request (the `:resourceId` in the
 * path, or `resourceId` in the body), and some let the browser change what needs approval. So
 * this API serves only an allowlist of them, behind a guard that:
 *
 * - asks the host who is signed in and which client they may act on (`authorize`: Better Auth
 *   plus the staff check, never anything the request names);
 * - refuses any request whose resource is not that client's (`clientResource`);
 * - pins every live session to the member (`sessionScope`), so one member never drives
 *   another's session or reads its event stream. A change waiting for approval belongs to the
 *   client's thread, though: any member who may act on that client may decide it, as with
 *   `decideApproval`;
 * - drops any `requestContext` the browser sends;
 * - decodes the path once and serves only the exact paths the chat uses, forwarding the path it
 *   checked, so an encoded path never reads differently to the guard and the router.
 *
 * Threads belong to the client, not the member: any member who may act on a client can list,
 * open and rename its conversations. Live sessions and their event streams are per member.
 *
 * Not served: switching the model, setting session state (`yolo` would approve deletions),
 * permission rules, rebinding the resource, listing other resources or every active run,
 * cloning or deleting threads, goals, notifications and workspace routes.
 *
 * The controller keeps live sessions and approval gates in memory, and a message's reply
 * arrives on the session's event stream, so the host must be one long-running process.
 */

import { CONTROLLER_ID, clientResource } from "@locus/harness";
import { Mastra } from "@mastra/core";
import type { AgentController } from "@mastra/core/agent-controller";
import { MastraServer } from "@mastra/hono";
import {
  ABORT_AGENT_CONTROLLER_SESSION_ROUTE,
  AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE,
  AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE,
  CREATE_AGENT_CONTROLLER_SESSION_ROUTE,
  CREATE_AGENT_CONTROLLER_THREAD_ROUTE,
  FOLLOW_UP_AGENT_CONTROLLER_SESSION_ROUTE,
  GET_AGENT_CONTROLLER_SESSION_STATE_ROUTE,
  LIST_AGENT_CONTROLLER_MODES_ROUTE,
  LIST_AGENT_CONTROLLER_THREAD_MESSAGES_ROUTE,
  LIST_AGENT_CONTROLLER_THREADS_ROUTE,
  RENAME_AGENT_CONTROLLER_THREAD_ROUTE,
  SEND_AGENT_CONTROLLER_MESSAGE_ROUTE,
  STEER_AGENT_CONTROLLER_SESSION_ROUTE,
  STREAM_AGENT_CONTROLLER_SESSION_ROUTE,
  SWITCH_AGENT_CONTROLLER_MODE_ROUTE,
  SWITCH_AGENT_CONTROLLER_THREAD_ROUTE,
} from "@mastra/server/handlers/agent-controller";
import { Hono } from "hono";

/** The Mastra routes the chat needs. Anything else answers 404. */
export const SERVED_ROUTES = [
  CREATE_AGENT_CONTROLLER_SESSION_ROUTE,
  GET_AGENT_CONTROLLER_SESSION_STATE_ROUTE,
  STREAM_AGENT_CONTROLLER_SESSION_ROUTE,
  SEND_AGENT_CONTROLLER_MESSAGE_ROUTE,
  STEER_AGENT_CONTROLLER_SESSION_ROUTE,
  FOLLOW_UP_AGENT_CONTROLLER_SESSION_ROUTE,
  ABORT_AGENT_CONTROLLER_SESSION_ROUTE,
  AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE,
  AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE,
  SWITCH_AGENT_CONTROLLER_MODE_ROUTE,
  SWITCH_AGENT_CONTROLLER_THREAD_ROUTE,
  LIST_AGENT_CONTROLLER_MODES_ROUTE,
  LIST_AGENT_CONTROLLER_THREADS_ROUTE,
  CREATE_AGENT_CONTROLLER_THREAD_ROUTE,
  RENAME_AGENT_CONTROLLER_THREAD_ROUTE,
  LIST_AGENT_CONTROLLER_THREAD_MESSAGES_ROUTE,
];

/** Who is asking, as the host established it. */
export interface AgentApiMember {
  memberId: string;
  /** The client (GHL location) this member may act on, after the staff check. */
  locationId: string;
}

export interface AgentApiConfig {
  /** Where the API is mounted, e.g. `/api/agent`. The chat client's `apiPrefix` matches it. */
  prefix: string;
  /**
   * The signed-in member and their client, or null when nobody is signed in or they may not
   * act on any client. Must never take the client from the request's path, query or body.
   */
  authorize: (request: Request) => Promise<AgentApiMember | null>;
  /** The controller for one client (`createLocusController`), created once and reused. */
  controllerFor: (locationId: string) => Promise<AgentController>;
  /**
   * Values the host puts on each run's request context, worked out server-side (for example
   * the site being built, after checking it belongs to the member's client). Whatever the
   * browser sends as `requestContext` is dropped; these replace it.
   */
  requestContext?: (request: Request, member: AgentApiMember) => Promise<Record<string, unknown>>;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function deny(status: 400 | 401 | 403 | 404, error: string) {
  return Response.json({ error }, { status });
}

export function createAgentApi({
  prefix,
  authorize,
  controllerFor,
  requestContext,
}: AgentApiConfig) {
  const base = `${prefix}/agent-controller/${CONTROLLER_ID}`;
  const apps = new Map<string, Promise<Hono>>();

  const appFor = (locationId: string) => {
    let app = apps.get(locationId);
    if (!app) {
      app = (async () => {
        const controller = await controllerFor(locationId);
        const mastra = new Mastra({
          agentControllers: { [CONTROLLER_ID]: controller },
          logger: false,
        });
        const hono = new Hono();
        const server = new MastraServer({ app: hono, mastra, prefix });
        server.registerContextMiddleware();
        // Mastra's route constants don't satisfy its own ServerRoute type under
        // exactOptionalPropertyTypes; they are the routes the adapter is written for.
        for (const route of SERVED_ROUTES) {
          await server.registerRoute(hono, route as Parameters<typeof server.registerRoute>[1]);
        }
        return hono;
      })();
      app.catch(() => apps.delete(locationId));
      apps.set(locationId, app);
    }
    return app;
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${base}/`)) {
        return deny(404, "not found");
      }
      const member = await authorize(request);
      if (!member) return deny(401, "sign in first");
      const resourceId = clientResource({ token: "", tokenKind: "location", ...member });
      const scope = `member:${member.memberId}`;
      const context = (await requestContext?.(request, member)) ?? {};
      const hasContext = Object.keys(context).length > 0;

      // Decode the path once, as the router will, and serve only the exact shapes the chat
      // uses. The forwarded request carries the path rebuilt from the decoded segments, so the
      // guard and the router can never read it differently.
      const segments = decodeSegments(url.pathname.slice(base.length));
      if (!segments) return deny(400, "bad path");
      const shape = routeShape(request.method, segments);
      if (!shape) return deny(404, "not found");
      if (shape !== "modes" && shape !== "create" && segments[1] !== resourceId) {
        return deny(403, "not your client");
      }

      let body: string | undefined;
      if (BODY_METHODS.has(request.method)) {
        const sent = await readJson(request);
        if (sent === undefined) return deny(400, "bad request");
        if (shape === "create") {
          // Create or resume a session: the client and scope are ours, not the request's.
          if (sent.resourceId !== resourceId) return deny(403, "not your client");
          const { tags: _tags, ...rest } = sent;
          body = JSON.stringify({
            ...withHostContext(rest, context),
            resourceId,
            sessionScope: scope,
          });
        } else {
          body = JSON.stringify(withHostContext(sent, context));
        }
      }
      url.pathname = [base, ...segments.map(encodeURIComponent)].join("/");
      url.searchParams.delete("sessionScope");
      if (shape !== "modes") url.searchParams.set("sessionScope", scope);
      url.searchParams.delete("requestContext");
      if (hasContext && !BODY_METHODS.has(request.method)) {
        url.searchParams.set("requestContext", JSON.stringify(context));
      }

      const headers = new Headers(request.headers);
      if (body !== undefined) {
        headers.set("content-type", "application/json");
        headers.delete("content-length");
      }
      const forwarded = new Request(url, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: request.signal,
      });
      const app = await appFor(member.locationId);
      return app.fetch(forwarded);
    },
  };
}

/** The path's segments, each decoded, or null when one is malformed, empty or a dot segment. */
function decodeSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const raw of path.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment === "." || segment === "..") return null;
    segments.push(segment);
  }
  return segments;
}

/** Session routes after `sessions/:resourceId`, by method. */
const SESSION_TAILS: Record<string, readonly string[]> = {
  GET: ["", "stream", "threads"],
  POST: [
    "messages",
    "steer",
    "follow-up",
    "abort",
    "tool-approval",
    "tool-suspension",
    "mode",
    "thread",
    "threads",
  ],
};

/** Which served route a decoded path is, or null for anything else. */
function routeShape(method: string, segments: string[]): "modes" | "create" | "session" | null {
  const [first, , ...tail] = segments;
  if (first === "modes") return segments.length === 1 && method === "GET" ? "modes" : null;
  if (first !== "sessions") return null;
  if (segments.length === 1) return method === "POST" ? "create" : null;
  if (tail.length <= 1 && SESSION_TAILS[method]?.includes(tail[0] ?? "")) return "session";
  // threads/:threadId (rename) and threads/:threadId/messages
  if (tail[0] === "threads" && tail.length === 2 && method === "PUT") return "session";
  if (tail[0] === "threads" && tail.length === 3 && tail[2] === "messages" && method === "GET") {
    return "session";
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The body without the browser's `requestContext`, and with the host's when it has one. */
function withHostContext(body: Record<string, unknown>, context: Record<string, unknown>) {
  const { requestContext: _dropped, ...rest } = body;
  return Object.keys(context).length > 0 ? { ...rest, requestContext: context } : rest;
}
