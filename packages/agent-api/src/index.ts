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
 * - drops any `requestContext` the browser sends.
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
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function deny(status: 401 | 403 | 404, error: string) {
  return Response.json({ error }, { status });
}

export function createAgentApi({ prefix, authorize, controllerFor }: AgentApiConfig) {
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
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
        return deny(404, "not found");
      }
      const member = await authorize(request);
      if (!member) return deny(401, "sign in first");
      const resourceId = clientResource({ token: "", tokenKind: "location", ...member });
      const scope = `member:${member.memberId}`;

      // ["sessions", resourceId, ...] or ["modes"]
      const rest = url.pathname.slice(base.length + 1).split("/");
      let body: string | undefined;
      if (rest[0] === "sessions") {
        if (rest.length === 1) {
          // Create or resume a session: the client and scope are ours, not the request's.
          const sent = await readJson(request);
          if (sent === undefined) return deny(403, "bad request");
          if (sent.resourceId !== resourceId) return deny(403, "not your client");
          body = JSON.stringify({ ...withoutContext(sent), resourceId, sessionScope: scope });
        } else {
          if (decodeURIComponent(rest[1] ?? "") !== resourceId) {
            return deny(403, "not your client");
          }
          if (BODY_METHODS.has(request.method)) {
            const sent = await readJson(request);
            if (sent === undefined) return deny(403, "bad request");
            body = JSON.stringify(withoutContext(sent));
          }
        }
        url.searchParams.set("sessionScope", scope);
      } else if (BODY_METHODS.has(request.method)) {
        const sent = await readJson(request);
        if (sent === undefined) return deny(403, "bad request");
        body = JSON.stringify(withoutContext(sent));
      }
      url.searchParams.delete("requestContext");

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

function withoutContext(body: Record<string, unknown>) {
  const { requestContext: _dropped, ...rest } = body;
  return rest;
}
