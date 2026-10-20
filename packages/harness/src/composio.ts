/**
 * Connected apps through Composio (https://composio.dev). Composio keeps each app's sign-in and
 * runs its tools; Locus holds one Composio API key for Otaku's project.
 *
 * Each Locus client is one Composio user (`appUserId`), so a client's chat can only ever use
 * the accounts that client connected. The session is built for that user with Locus's allowed
 * apps only, can't create sign-in links (connecting happens on the Apps page, by a
 * person), and never falls back to Composio-owned "Instant" accounts, which Composio charges for.
 */

import { Composio } from "@composio/core";
import { APP_TOOLKITS, type AppConnector, AppServiceError, type AppTool, allowed } from "./apps.ts";

/** The Composio user a Locus client's connections belong to. */
export function appUserId(clientId: string): string {
  if (!clientId) throw new Error("connected apps need a client");
  return `locus-client:${clientId}`;
}

export interface ComposioConnectorConfig {
  apiKey: string;
  /** The Locus client (one GHL location) whose apps these are; from the session, never a request. */
  clientId: string;
  /** Composio's API, for tests; defaults to Composio's own. */
  baseURL?: string;
}

const READ_ONLY_TAG = "readOnlyHint";

export function createComposioConnector({
  apiKey,
  clientId,
  baseURL,
}: ComposioConnectorConfig): AppConnector {
  const composio = new Composio({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    allowTracking: false,
    disableVersionCheck: true,
  });
  const userId = appUserId(clientId);
  let session: ReturnType<typeof open> | undefined;
  const open = () =>
    composio.create(userId, {
      toolkits: [...APP_TOOLKITS],
      manageConnections: false,
      instant: false,
    });
  const current = () => {
    session ??= open().catch((error) => {
      // A failed start isn't kept: the next call tries again.
      session = undefined;
      throw error;
    });
    return session;
  };
  /**
   * Composio's own failures (a 4xx naming an unconnected app, an outage) become data the model
   * reads through the screen; thrown, Mastra would hand their text to the model unscreened.
   * The session is dropped too, so one Composio expired or lost is opened again next time.
   */
  const service = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppServiceError) throw error;
      session = undefined;
      throw new AppServiceError(
        `Composio: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  // Tool metadata is Composio's own description of the tool, not anyone's data; kept for the
  // life of the process.
  const readOnly = new Map<string, Promise<boolean>>();

  return {
    search: (query) =>
      service(async () => {
        const found = await (await current()).search({ query, toolkits: [...APP_TOOLKITS] });
        if (!found.success)
          throw new AppServiceError(`Composio: ${found.error ?? "search failed"}`);
        const slugs = new Set(
          found.results.flatMap((r) => [...r.primaryToolSlugs, ...r.relatedToolSlugs]),
        );
        const tools: AppTool[] = [...slugs].flatMap((slug) => {
          const schema = found.toolSchemas[slug];
          // Without its arguments' schema the model could only guess how to call it.
          if (!schema?.inputSchema || schema.hasFullSchema === false) return [];
          return [
            {
              slug,
              toolkit: schema.toolkit,
              description: schema.description ?? "",
              inputSchema: schema.inputSchema,
            },
          ];
        });
        const notConnected = found.toolkitConnectionStatuses
          .filter((status) => !status.hasActiveConnection)
          .map((status) => status.toolkit);
        return { tools, notConnected };
      }),

    readOnly(slug) {
      let known = readOnly.get(slug);
      if (!known) {
        known = composio.tools
          .getRawComposioToolBySlug(slug)
          .then(
            (tool) =>
              allowed(tool.toolkit?.slug ?? "") && (tool.tags ?? []).includes(READ_ONLY_TAG),
          );
        // Only answers are kept; a failed lookup is asked again next time.
        known.catch(() => readOnly.delete(slug));
        readOnly.set(slug, known);
      }
      return known;
    },

    execute: (slug, args) =>
      service(async () => {
        const result = await (await current()).execute(slug, args);
        if (result.resultType === "completed") return { ok: true, data: result.data };
        return { ok: false, error: result.error || `${slug} failed` };
      }),
  };
}

/** One allowed app and whether the client has connected it. */
export interface AppConnection {
  toolkit: string;
  name: string;
  connected: boolean;
}

/**
 * Connecting and disconnecting a client's apps, for the Apps page. Callers check the
 * member may manage the client first; the client id comes from that check, never a form.
 * Connected-account ids are looked up for the client here, so nothing a browser sends can name
 * another client's account.
 */
export function createComposioConnections({
  apiKey,
  baseURL,
}: Omit<ComposioConnectorConfig, "clientId">) {
  const composio = new Composio({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    allowTracking: false,
    disableVersionCheck: true,
  });
  const sessionFor = (clientId: string) =>
    composio.create(appUserId(clientId), {
      toolkits: [...APP_TOOLKITS],
      manageConnections: false,
      instant: false,
    });
  const states = async (clientId: string) =>
    (await (await sessionFor(clientId)).toolkits({ toolkits: [...APP_TOOLKITS] })).items;
  /** Every account the client has for the app, in any state, across Composio's pages. */
  const accounts = async (clientId: string, slug: string) => {
    const found: { id: string; status: string }[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await composio.connectedAccounts.list({
        userIds: [appUserId(clientId)],
        toolkitSlugs: [slug],
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.items.map((a) => ({ id: a.id, status: a.status })));
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  };
  const offered = (toolkit: string) => {
    if (!allowed(toolkit)) throw new AppServiceError(`Locus doesn't offer ${toolkit}`);
    return toolkit.toLowerCase();
  };

  return {
    async list(clientId: string): Promise<AppConnection[]> {
      const items = await states(clientId);
      return APP_TOOLKITS.map((toolkit) => {
        const item = items.find((i) => i.slug.toLowerCase() === toolkit);
        return {
          toolkit,
          name: item?.name ?? toolkit,
          connected: item?.connection?.isActive === true,
        };
      });
    },

    /**
     * The app's own sign-in page; it comes back to `callbackUrl` when the person is done.
     * Accounts left half-connected or expired by earlier tries are removed first, so they can't
     * pile up where nobody can see or remove them.
     */
    async connect(clientId: string, toolkit: string, callbackUrl: string): Promise<string> {
      const slug = offered(toolkit);
      for (const account of await accounts(clientId, slug)) {
        if (account.status !== "ACTIVE") await composio.connectedAccounts.delete(account.id);
      }
      const request = await (await sessionFor(clientId)).authorize(slug, { callbackUrl });
      if (!request.redirectUrl)
        throw new AppServiceError(`Composio gave no sign-in link for ${toolkit}`);
      return request.redirectUrl;
    },

    /** Removes every account the client has for the app, so none is left for the chat to use. */
    async disconnect(clientId: string, toolkit: string): Promise<void> {
      const slug = offered(toolkit);
      for (const account of await accounts(clientId, slug)) {
        await composio.connectedAccounts.delete(account.id);
      }
    },
  };
}

export type AppConnections = ReturnType<typeof createComposioConnections>;
