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
 * answers to the agent's questions, the client's threads, their messages and what a work thread
 * waits on, and the session's goal and observational memory. A request about a work thread
 * (`work-threads.ts`) drives that thread's own session, with the same caller's context.
 *
 * Two routes are Locus's own, over the member's own conversations only:
 * - `PATCH /threads/:id` renames one (`{ title }`), or tags it with the site it is about
 *   (`{ site }`), so a site's chat keeps its conversation apart from the main chat. The tag is a
 *   label for listing, never a target anything acts on.
 * - `DELETE /threads/:id` deletes a chat and the work threads it started, but never while one
 *   of them is working or waiting for the member, and never a work thread on its own.
 *
 * Not served: archiving, schedules, and the kit's workspace, browser and image routes, which
 * belong to the whole server rather than one client.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CONTROLLER_ID, controllerStorage, openClientSession, TAINT_KEY } from "@locus/harness";
import type { AgentController, Session } from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { Context } from "hono";
import {
  SITE_TAG,
  SITE_THREAD_KEY,
  WORK_THREAD_KEY,
  workThreadOf,
} from "./mastra/lib/work-thread-info.ts";
import { createControllerRoutes } from "./mastra/routes/controller.ts";
import { createThreadRoutes, ownsThread } from "./mastra/routes/threads.ts";
import type { ChatServerDeps } from "./mastra/routes/types.ts";
import { workThreadsOf } from "./work-threads.ts";

/** Who a kit request is for, and the request context its runs carry. */
export interface KitCaller {
  memberId: string;
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
    (tail.length === 3 &&
      tail[0] === "threads" &&
      ["messages", "pending"].includes(tail[2] as string)),
  POST: (tail) =>
    tail.length === 1 && ["stream", "approve", "answer", "abort"].includes(tail[0] as string),
  PATCH: (tail) => tail.length === 2 && tail[0] === "threads" && tail[1] !== "search",
  DELETE: (tail) => tail.length === 2 && tail[0] === "threads" && tail[1] !== "search",
};

/** Whether a decoded kit path (the segments after `/agent-controller/`) is one this API serves. */
export function isKitRoute(method: string, tail: string[]): boolean {
  return KIT_ROUTES[method]?.(tail) ?? false;
}

/** The kit's routes for one client's controller. */
export function kitRoutes(controller: AgentController) {
  const callerOf = () => {
    const who = caller.getStore();
    // Only the guard calls into these routes, and always inside `asCaller`.
    if (!who) throw new Error("kit route reached without a caller");
    return who;
  };
  const getSession = async (): Promise<Session> => {
    const who = callerOf();
    // The member's own session over the controller's client: the one Mastra's routes reach.
    return withHostContext(
      await openClientSession(controller, { memberId: who.memberId }),
      who.context,
    );
  };
  const unserved = () => {
    throw new Error("not served");
  };
  /**
   * A work thread's own session (`start_thread`), for the routes that act on that thread. Only
   * a work thread over this controller's client has one; the resource is the member's own
   * session's, never one the route names.
   */
  const getThreadSession = async (threadId: string): Promise<Session | undefined> => {
    const threads = workThreadsOf(controller);
    if (!threads) return undefined;
    const { identity } = await getSession();
    const work = await threads.sessionForThread(threadId, identity.getResourceId());
    if (!work) return undefined;
    // A thread started by a run that read untrusted content stays tainted: every change in it
    // waits for a person, whoever's reply or answer starts the run.
    const untrusted = (await threads.threadInfo(threadId))?.untrusted === true;
    return withHostContext(work, {
      ...callerOf().context,
      ...(untrusted ? { [TAINT_KEY]: true } : {}),
    });
  };
  const deps: ChatServerDeps = {
    getSession,
    getThreadSession,
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
    "GET /agent-controller/threads/:id/pending",
    "POST /agent-controller/stream",
    "POST /agent-controller/approve",
    "POST /agent-controller/answer",
    "POST /agent-controller/abort",
    "GET /agent-controller/goal",
    "GET /agent-controller/om",
  ]);
  const kit = [...createThreadRoutes(deps), ...createControllerRoutes(deps)].filter((route) =>
    served.has(`${route.method} ${route.path}`),
  );
  return [
    ...kit,
    patchThreadRoute(controller, getSession),
    deleteThreadRoute(controller, getSession),
  ];
}

/** The longest name a conversation may be given. */
const TITLE_MAX = 120;

/** The client's conversation store, holding its threads. */
async function memoryOf(controller: AgentController) {
  const store = await controllerStorage(controller).getStore("memory");
  if (!store) throw new Error("the controller's store keeps no threads");
  return store;
}

/**
 * Renames one of the member's own conversations (`{ title }`), tags it (`{ site }`), or files a
 * work thread under Resolved and back (`{ resolved }`).
 */
function patchThreadRoute(controller: AgentController, getSession: () => Promise<Session>) {
  const tag = siteTag(controller, getSession);
  return registerApiRoute("/agent-controller/threads/:id", {
    method: "PATCH",
    handler: async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        site?: unknown;
        title?: unknown;
        resolved?: unknown;
      } | null;
      if (body?.site !== undefined) return tag(c, c.req.param("id"), body.site);
      if (typeof body?.resolved === "boolean") {
        return resolve(controller, getSession, c.req.param("id"), body.resolved, c);
      }
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title || title.length > TITLE_MAX) {
        return c.json({ error: `send { title } of 1 to ${TITLE_MAX} characters` }, 400);
      }
      const id = c.req.param("id");
      if (!(await ownsThread(await getSession(), id))) return c.json({ error: "not found" }, 404);
      const store = await memoryOf(controller);
      await store.patchThread({ id, title });
      // A name the person chose stays: memory's title writer leaves a pinned title alone.
      await store.updateThreadMetadata({ id, update: () => ({ titlePinned: true }) });
      return c.json({ ok: true });
    },
  });
}

/** Files one of the member's own work threads under Resolved, or takes it back out. */
async function resolve(
  controller: AgentController,
  getSession: () => Promise<Session>,
  id: string,
  resolved: boolean,
  c: Context,
) {
  if (!(await ownsThread(await getSession(), id))) return c.json({ error: "not found" }, 404);
  const store = await memoryOf(controller);
  let work = false;
  await store.updateThreadMetadata({
    id,
    update: (thread) => {
      const info = workThreadOf(thread);
      if (!info) return undefined;
      work = true;
      const { resolved: _, ...rest } = info;
      return { [WORK_THREAD_KEY]: resolved ? { ...rest, resolved: true } : rest };
    },
  });
  if (!work) return c.json({ error: "only a thread can be resolved" }, 409);
  return c.json({ ok: true });
}

/**
 * Deletes one of the member's own chats with the work threads it started. Refused while any of
 * them is working or waiting for the member, so no run is left writing into, or parked on, a
 * thread that is gone.
 */
function deleteThreadRoute(controller: AgentController, getSession: () => Promise<Session>) {
  return registerApiRoute("/agent-controller/threads/:id", {
    method: "DELETE",
    handler: async (c) => {
      const id = c.req.param("id");
      const session = await getSession();
      if (!(await ownsThread(session, id))) return c.json({ error: "not found" }, 404);
      const store = await memoryOf(controller);
      const { threads } = await store.listThreads({ perPage: false });
      const own = threads.find((t) => t.id === id);
      // A work thread is deleted with the chat that started it, never on its own.
      if (!own || workThreadOf(own)) {
        return c.json({ error: "delete the chat that started this thread" }, 409);
      }
      const started = threads.filter((t) => workThreadOf(t)?.parentThreadId === id);
      const work = workThreadsOf(controller);
      for (const t of started) {
        // A run saves `working` only once it has begun, so the live Session is asked too.
        const status = workThreadOf(t)?.status;
        if (status === "working" || status === "needs_you" || (await work?.busy(t.id))) {
          return c.json(
            { error: "a thread in this chat is still working or waiting for you" },
            409,
          );
        }
      }
      for (const t of started) {
        await work?.forget(t.id, t.resourceId);
        await store.deleteThread({ threadId: t.id });
      }
      // Through the session, which also stops a run of the member's own on this thread.
      await session.thread.delete({ threadId: id });
      return c.json({ ok: true });
    },
  });
}

/**
 * Tags one of the member's own conversations with the site it is about. Only an ordinary
 * conversation: a work thread already belongs to the main chat. Once tagged it stays that
 * site's, so a second tag for another site is refused.
 */
function siteTag(controller: AgentController, getSession: () => Promise<Session>) {
  return async (c: Context, id: string, site: unknown) => {
    if (typeof site !== "string" || !SITE_TAG.test(site)) {
      return c.json({ error: "send { site }" }, 400);
    }
    if (!(await ownsThread(await getSession(), id))) return c.json({ error: "not found" }, 404);
    const store = await memoryOf(controller);
    const thread = await store.getThreadById({ threadId: id });
    if (!thread || workThreadOf(thread)) return c.json({ error: "not found" }, 404);
    // Checked inside the store's update, so two tags sent at once can't both win.
    let other = false;
    await store.updateThreadMetadata({
      id,
      update: (current) => {
        const tagged = (current.metadata as Record<string, unknown> | undefined)?.[SITE_THREAD_KEY];
        other = tagged !== undefined && tagged !== site;
        return tagged === undefined ? { [SITE_THREAD_KEY]: site } : undefined;
      },
    });
    if (other) return c.json({ error: "this conversation is another site's" }, 409);
    return c.json({ ok: true });
  };
}

/**
 * The session, with the host's values put on the request context of every run it starts or
 * resumes, over whatever the kit's route set (the browser's time zone, its search toggle).
 * An answer first claims the question it answers, as Mastra's own route does, so two answers
 * sent at once can't resume one tool twice.
 */
function withHostContext(session: Session, context: Record<string, unknown>): Session {
  const entries = Object.entries(context);
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
        return async (input: Parameters<Session["respondToToolSuspension"]>[0]) => {
          const claim = target.claimToolSuspension(input.toolCallId);
          if (!claim.accepted) throw new Error(`answer not accepted: ${claim.reason}`);
          try {
            return await target.respondToToolSuspension({
              ...input,
              requestContext: merged(input.requestContext),
            });
          } finally {
            target.releaseToolResponse(claim.toolCallId);
          }
        };
      }
      const value = Reflect.get(target, key, target);
      // Session keeps private fields, so its methods must run on the session itself.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
