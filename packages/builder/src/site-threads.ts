import { SITE_KINDS } from "@locus/studio";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { BuilderError, recoverable } from "./tools.ts";

/**
 * How the builder reads and sets the site a conversation is about, in the client's own chat
 * store. A work thread (one the main chat started) builds only the site it is tagged with; it
 * gets its tag from `create_site` or `choose_site`, once.
 */
export interface SiteThreads {
  /** Whether the thread is a work thread, and the site it is tagged with. Null if unknown. */
  of(threadId: string): Promise<{ work: boolean; siteId?: string | undefined } | null>;
  /** Tags a work thread with a site. False when it is already another site's. */
  tag(threadId: string, siteId: string): Promise<boolean>;
}

/** What the site tools need from the host, each for the run's own member (staff-checked). */
export interface SiteThreadToolDeps {
  threads: SiteThreads;
  /** The client's sites the builder may work on, by name. */
  list(requestContext: unknown): Promise<{ id: string; name: string }[]>;
  /** Creates a site for the client and starts it from its template. Returns its id. */
  create(
    requestContext: unknown,
    input: { name: string; kind: string; description?: string; goal?: string; audience?: string },
  ): Promise<string>;
  /** Checks the builder may work on this site of the client's. Returns its id. */
  choose(requestContext: unknown, siteId: string): Promise<string>;
}

export const SITE_THREAD_TOOL_NAMES = ["list_sites", "create_site", "choose_site"] as const;

/** Said by every builder tool in a thread that has no site yet. */
export const NO_THREAD_SITE =
  "This thread has no site yet. Make one with create_site, or find one with list_sites and pick it with choose_site.";

const noApproval = () => false;

type ToolContext = { requestContext?: unknown; agent?: { threadId?: string } };

/** The tools a site-builder thread uses to pick the one site it works on. */
export function createSiteThreadTools(deps: SiteThreadToolDeps) {
  /**
   * One site change per thread at a time: a step's tool calls run together, and two
   * create_site calls checked at once would both make a site (and both count on the plan).
   */
  const queues = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(threadId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(threadId) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    queues.set(threadId, settled);
    void settled.then(() => {
      if (queues.get(threadId) === settled) queues.delete(threadId);
    });
    return run;
  };

  /** The run's work thread and its site, or a refusal for any other conversation. */
  const workThread = async (context: ToolContext) => {
    const threadId = context?.agent?.threadId;
    const thread = threadId ? await deps.threads.of(threadId) : null;
    if (!threadId || !thread?.work) {
      throw new BuilderError(
        "Only a thread picks its site. This chat works on the site its page is for.",
      );
    }
    return { threadId, siteId: thread.siteId };
  };

  /** Tags the thread, unless it already has another site. */
  const bind = async (threadId: string, siteId: string) => {
    if (!(await deps.threads.tag(threadId, siteId))) {
      throw new BuilderError("This thread already works on another site.");
    }
  };

  const listSites = createTool({
    id: "list_sites",
    description: "The client's sites you can work on, with their ids and names.",
    requireApproval: noApproval,
    inputSchema: z.object({}),
    execute: async (_input, context: ToolContext) =>
      recoverable(async () => ({ sites: await deps.list(context?.requestContext) })),
  });

  const createSite = createTool({
    id: "create_site",
    description:
      "Start a new site for the client, from the template for its kind, and make it this " +
      "thread's site. Use it once, when the work is a new website, landing page or funnel.",
    requireApproval: noApproval,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe("The site's name."),
      kind: z.enum(SITE_KINDS).describe("What it is."),
      description: z.string().max(4000).optional().describe("What the person wants."),
      goal: z.string().max(500).optional(),
      audience: z.string().max(500).optional().describe("Who it is for."),
    }),
    execute: async (input, context: ToolContext) =>
      recoverable(async () => {
        const threadId = (await workThread(context)).threadId;
        return oneAtATime(threadId, async () => {
          const thread = await workThread(context);
          if (thread.siteId) throw new BuilderError("This thread already has its site.");
          const siteId = await deps.create(context?.requestContext, {
            name: input.name,
            kind: input.kind,
            ...(input.description ? { description: input.description } : {}),
            ...(input.goal ? { goal: input.goal } : {}),
            ...(input.audience ? { audience: input.audience } : {}),
          });
          await bind(thread.threadId, siteId);
          return { siteId, note: "Version 1 is ready. Read the brief next." };
        });
      }),
  });

  const chooseSite = createTool({
    id: "choose_site",
    description:
      "Make one of the client's existing sites (an id from list_sites) this thread's site.",
    requireApproval: noApproval,
    inputSchema: z.object({ siteId: z.string().min(1).max(64) }),
    execute: async (input, context: ToolContext) =>
      recoverable(async () => {
        const threadId = (await workThread(context)).threadId;
        return oneAtATime(threadId, async () => {
          const thread = await workThread(context);
          if (thread.siteId === input.siteId) return { siteId: input.siteId };
          if (thread.siteId) throw new BuilderError("This thread already works on another site.");
          const siteId = await deps.choose(context?.requestContext, input.siteId);
          await bind(thread.threadId, siteId);
          return { siteId };
        });
      }),
  });

  return { list_sites: listSites, create_site: createSite, choose_site: chooseSite };
}

export type SiteThreadTools = ReturnType<typeof createSiteThreadTools>;
