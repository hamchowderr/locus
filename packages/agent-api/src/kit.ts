/**
 * The chat kit's own routes (`hamchowderr/mastra-chat-kit`, installed from its registry as
 * `chat-server` into `src/mastra/`), served behind the same guard as Mastra's routes.
 *
 * The kit's web proxy calls `/agent-controller/stream`, `/approve`, `/answer` and the thread
 * routes, and its routes ask `getSession()` for the Session to drive. Here that is always the
 * signed-in member's own session over their client's resource, worked out by the guard and
 * handed down in an `AsyncLocalStorage`, never read from the request. Every run started or
 * resumed through it gets the host's request context, as Mastra's routes do.
 *
 * Served: the stream, approvals (not "always allow", which would change what needs approval),
 * answers to the agent's questions, the client's threads and their messages, and the session's
 * goal and observational memory. Not served: deleting or renaming threads, schedules, and the
 * kit's workspace, browser and image routes, which belong to the whole server rather than one
 * client.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CONTROLLER_ID } from "@locus/harness";
import type { AgentController, Session } from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";
import { createControllerRoutes } from "./mastra/routes/controller.ts";
import { createThreadRoutes } from "./mastra/routes/threads.ts";
import type { ChatServerDeps } from "./mastra/routes/types.ts";

/** Who a kit request is for, and the request context its runs carry. */
export interface KitCaller {
  resourceId: string;
  scope: string;
  context: Record<string, unknown>;
}

const caller = new AsyncLocalStorage<KitCaller>();

/** Runs `handle` as `who`: every session the kit's routes ask for inside it is theirs. */
export function asCaller<T>(who: KitCaller, handle: () => T): T {
  return caller.run(who, handle);
}

/** The kit route paths served, by method, after `/agent-controller/`. */
const KIT_ROUTES: Record<string, (tail: string[]) => boolean> = {
  GET: (tail) =>
    (tail.length === 1 && ["threads", "goal", "om"].includes(tail[0] as string)) ||
    (tail.length === 2 && tail[0] === "threads" && tail[1] === "search") ||
    (tail.length === 3 && tail[0] === "threads" && tail[2] === "messages"),
  POST: (tail) => tail.length === 1 && ["stream", "approve", "answer"].includes(tail[0] as string),
};

/** Whether a decoded kit path (the segments after `/agent-controller/`) is one this API serves. */
export function isKitRoute(method: string, tail: string[]): boolean {
  return KIT_ROUTES[method]?.(tail) ?? false;
}

/** The kit's routes for one client's controller. */
export function kitRoutes(controller: AgentController) {
  const getSession = async (): Promise<Session> => {
    const who = caller.getStore();
    // Only the guard calls into these routes, and always inside `asCaller`.
    if (!who) throw new Error("kit route reached without a caller");
    await controller.init();
    // The same id Mastra's own routes give a scoped session, so both reach one session.
    const session = await controller.createSession({
      resourceId: who.resourceId,
      id: `${who.resourceId}::${who.scope}`,
      ownerId: controller.id,
      scope: who.scope,
    });
    return withHostContext(session, who.context);
  };
  const unserved = () => {
    throw new Error("not served");
  };
  const deps: ChatServerDeps = {
    getSession,
    getAgentController: async () => controller,
    agentId: CONTROLLER_ID,
    // Never switch models from the browser: the allowlist is empty.
    modelAllowlist: new Set(),
    workspace: { root: "", readTree: unserved, readFile: unserved },
    getImage: () => undefined,
    getBrowser: unserved,
  };
  const served = new Set([
    "GET /agent-controller/threads",
    "GET /agent-controller/threads/search",
    "GET /agent-controller/threads/:id/messages",
    "POST /agent-controller/stream",
    "POST /agent-controller/approve",
    "POST /agent-controller/answer",
    "GET /agent-controller/goal",
    "GET /agent-controller/om",
  ]);
  return [...createThreadRoutes(deps), ...createControllerRoutes(deps)].filter((route) =>
    served.has(`${route.method} ${route.path}`),
  );
}

/**
 * The session, with the host's values put on the request context of every run it starts or
 * resumes, over whatever the kit's route set (the browser's time zone, its search toggle).
 */
function withHostContext(session: Session, context: Record<string, unknown>): Session {
  const entries = Object.entries(context);
  if (entries.length === 0) return session;
  const merged = (requestContext: RequestContext | undefined) => {
    const into = requestContext ?? new RequestContext();
    for (const [key, value] of entries) into.set(key, value);
    return into;
  };
  return new Proxy(session, {
    get(target, key) {
      if (key === "sendMessage") {
        return (input: Parameters<Session["sendMessage"]>[0]) =>
          target.sendMessage({ ...input, requestContext: merged(input.requestContext) });
      }
      if (key === "respondToToolSuspension") {
        return (input: Parameters<Session["respondToToolSuspension"]>[0]) =>
          target.respondToToolSuspension({
            ...input,
            requestContext: merged(input.requestContext),
          });
      }
      const value = Reflect.get(target, key, target);
      // Session keeps private fields, so its methods must run on the session itself.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
