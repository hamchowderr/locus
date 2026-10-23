/**
 * Connected apps through Composio (https://composio.dev). Composio keeps each app's sign-in and
 * runs its tools; Locus holds one Composio API key for Otaku's project.
 *
 * Each Locus client is one Composio user (`appUserId`), so a client's chat can only ever use
 * the accounts that client connected. Locus offers every app in Composio's catalog whose sign-in
 * Composio manages (`createComposioCatalog`); the client's chat uses the ones an owner or admin
 * connected for it. Sessions can't create sign-in links (connecting happens on the Apps page, by
 * a person), and never fall back to Composio-owned "Instant" accounts, which Composio charges for.
 */

import {
  Composio,
  ComposioConnectedAccountNotRevokableError,
  ComposioConnectedAccountRevocationNotSupportedError,
} from "@composio/core";
import { type AppConnector, AppServiceError, type AppTool } from "./apps.ts";

const CLIENT_USER_PREFIX = "locus-client:";

/** The Composio user a Locus client's connections belong to. */
export function appUserId(clientId: string): string {
  if (!clientId) throw new Error("connected apps need a client");
  return `${CLIENT_USER_PREFIX}${clientId}`;
}

/** The Locus client a Composio user stands for (`appUserId` undone); undefined for any other. */
export function clientOfAppUser(userId: string): string | undefined {
  const clientId = userId.startsWith(CLIENT_USER_PREFIX)
    ? userId.slice(CLIENT_USER_PREFIX.length)
    : "";
  return clientId === "" ? undefined : clientId;
}

function composioClient(apiKey: string, baseURL: string | undefined) {
  return new Composio({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    allowTracking: false,
    disableVersionCheck: true,
  });
}

// ---------------------------------------------------------------------------------------------
// The catalog

/** One app Locus offers: Composio's own description of it, the same for every client. */
export interface CatalogApp {
  /** Composio's toolkit slug, lower case: `gmail`. */
  toolkit: string;
  name: string;
  description: string;
  /** Image URL, from Composio. */
  logo: string;
  categories: { id: string; name: string }[];
}

/** The apps Locus offers: Composio's catalog, where Composio manages the sign-in. */
export interface AppCatalog {
  /** In Composio's order (most used first). */
  apps(): Promise<CatalogApp[]>;
  /** Whether Locus offers the app with this toolkit slug. */
  offers(toolkit: string): Promise<boolean>;
}

/**
 * How long the catalog is kept. It is Composio's metadata about apps, never a client's data,
 * so keeping it a while is safe; it changes when Composio adds an app.
 */
export const CATALOG_TTL_MS = 10 * 60_000;
/** Composio's largest page. */
const CATALOG_PAGE = 1000;
/** The most apps a search names as not connected: the chat shows a Connect button for each. */
const NOT_CONNECTED_MAX = 4;

/** A bound on the pages read, should Composio's cursor never end. */
const CATALOG_MAX_PAGES = 20;

export interface ComposioCatalogConfig {
  apiKey: string;
  /** Composio's API, for tests; defaults to Composio's own. */
  baseURL?: string;
  ttlMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

/**
 * Composio's whole catalog, cut to the apps whose sign-in Composio manages: the only ones a
 * client can connect without Otaku registering an OAuth app of its own. Apps that need no
 * sign-in at all are left out too, since a client couldn't connect them.
 *
 * The SDK's `composio.toolkits.get({...})` returns one page and drops Composio's cursor, so the
 * pages are read through the SDK's own API client (`getClient().toolkits.list`).
 */
export function createComposioCatalog({
  apiKey,
  baseURL,
  ttlMs = CATALOG_TTL_MS,
  now = Date.now,
}: ComposioCatalogConfig): AppCatalog {
  const api = composioClient(apiKey, baseURL).getClient();

  const load = async () => {
    const apps: CatalogApp[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await api.toolkits.list({
        type: "native",
        include_deprecated: false,
        sort_by: "usage",
        limit: CATALOG_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        const toolkit = item.slug.toLowerCase();
        if (seen.has(toolkit) || !managed(item)) continue;
        seen.add(toolkit);
        apps.push({
          toolkit,
          name: item.name || item.slug,
          description: item.meta?.description ?? "",
          logo: item.meta?.logo ?? "",
          categories: (item.meta?.categories ?? []).map((c) => ({ id: c.id, name: c.name })),
        });
      }
      cursor = page.next_cursor || undefined;
      pages += 1;
    } while (cursor && pages < CATALOG_MAX_PAGES);
    return { apps, slugs: new Set(apps.map((app) => app.toolkit)) };
  };

  type Loaded = Awaited<ReturnType<typeof load>>;
  let cached: { at: number; loaded: Promise<Loaded> } | undefined;
  // The last catalog read in full: served while a refresh fails, so a Composio outage doesn't
  // take the Apps page and the chat's apps down with it.
  let lastGood: Loaded | undefined;
  const current = () => {
    if (!cached || now() - cached.at >= ttlMs) {
      const entry = {
        at: now(),
        loaded: load().then((loaded) => {
          lastGood = loaded;
          return loaded;
        }),
      };
      // A failed read isn't kept: the next call reads again.
      entry.loaded.catch(() => {
        if (cached === entry) cached = undefined;
      });
      cached = entry;
    }
    const stale = lastGood;
    return stale ? cached.loaded.catch(() => stale) : cached.loaded;
  };

  return {
    apps: async () => (await current()).apps,
    offers: async (toolkit) => (await current()).slugs.has(toolkit.toLowerCase()),
  };
}

/** An app Composio signs clients in to itself, with its own OAuth app or key form. */
function managed(item: {
  type?: string;
  no_auth?: boolean;
  composio_managed_auth_schemes?: string[];
}): boolean {
  if (item.type === "custom" || item.no_auth) return false;
  return (item.composio_managed_auth_schemes ?? []).length > 0;
}

/** One catalog per Composio project and process, shared by every client's connector. */
const catalogs = new Map<string, AppCatalog>();
export function composioCatalog(apiKey: string, baseURL?: string): AppCatalog {
  const key = `${baseURL ?? ""}\n${apiKey}`;
  let catalog = catalogs.get(key);
  if (!catalog) {
    catalog = createComposioCatalog({ apiKey, ...(baseURL ? { baseURL } : {}) });
    catalogs.set(key, catalog);
  }
  return catalog;
}

// ---------------------------------------------------------------------------------------------
// One client's chat

export interface ComposioConnectorConfig {
  apiKey: string;
  /** The Locus client (one GHL location) whose apps these are; from the session, never a request. */
  clientId: string;
  /** Composio's API, for tests; defaults to Composio's own. */
  baseURL?: string;
  /** The apps Locus offers; defaults to the process's shared catalog for this key. */
  catalog?: AppCatalog;
}

const READ_ONLY_TAG = "readOnlyHint";
const DESTRUCTIVE_TAG = "destructiveHint";
/**
 * A tool named for deleting or undoing something, should its app not tag it so:
 * GMAIL_DELETE_MESSAGE, GOOGLESHEETS_CLEAR_VALUES, SLACK_ARCHIVE_CONVERSATION.
 */
const DELETING_NAME =
  /(^|_)(DELETE|REMOVE|TRASH|DESTROY|PURGE|ERASE|WIPE|CLEAR|ARCHIVE|CANCEL|REVOKE|EMPTY|DROP|TRUNCATE|UNINSTALL|DISCARD)S?(_|$)/i;

export function createComposioConnector({
  apiKey,
  clientId,
  baseURL,
  catalog = composioCatalog(apiKey, baseURL),
}: ComposioConnectorConfig): AppConnector {
  const composio = composioClient(apiKey, baseURL);
  const userId = appUserId(clientId);
  let session: ReturnType<typeof open> | undefined;
  // Not limited to a list of toolkits: the catalog is long and changes. Locus checks every tool
  // against the catalog itself (`offers`), and only accounts the client connected can run.
  // Composio's code sandbox is off: Locus never offers its tools, and it isn't covered by
  // Composio's zero data retention.
  const open = () =>
    composio.create(userId, {
      manageConnections: false,
      instant: false,
      sandbox: { enable: false },
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
  // life of the process. Only answers are kept; a failed lookup is asked again next time.
  const tools = new Map<string, Promise<{ toolkit: string; tags: string[] }>>();
  const describe = (slug: string) => {
    let known = tools.get(slug);
    if (!known) {
      known = composio.tools.getRawComposioToolBySlug(slug).then((tool) => ({
        toolkit: (tool.toolkit?.slug ?? "").toLowerCase(),
        tags: tool.tags ?? [],
      }));
      known.catch(() => tools.delete(slug));
      tools.set(slug, known);
    }
    return known;
  };
  /** The tool's own toolkit, by Composio's metadata (never its name), is one Locus offers. */
  const offered = async (slug: string) => {
    const { toolkit } = await describe(slug);
    return toolkit !== "" && (await catalog.offers(toolkit));
  };

  return {
    search: (query) =>
      service(async () => {
        const found = await (await current()).search({ query });
        if (!found.success)
          throw new AppServiceError(`Composio: ${found.error ?? "search failed"}`);
        const connected = new Set<string>();
        const notConnected: string[] = [];
        for (const status of found.toolkitConnectionStatuses) {
          const toolkit = status.toolkit.toLowerCase();
          if (!(await catalog.offers(toolkit))) continue;
          if (status.hasActiveConnection) connected.add(toolkit);
          else if (!notConnected.includes(toolkit) && notConnected.length < NOT_CONNECTED_MAX)
            notConnected.push(toolkit);
        }
        const slugs = new Set(
          found.results.flatMap((r) => [...r.primaryToolSlugs, ...r.relatedToolSlugs]),
        );
        const tools: AppTool[] = [...slugs].flatMap((slug) => {
          const schema = found.toolSchemas[slug];
          // Without its arguments' schema the model could only guess how to call it.
          if (!schema?.inputSchema || schema.hasFullSchema === false) return [];
          // Only the client's connected apps: the others are named in `notConnected`.
          const toolkit = schema.toolkit.toLowerCase();
          if (!connected.has(toolkit)) return [];
          return [
            {
              slug,
              toolkit,
              description: schema.description ?? "",
              inputSchema: schema.inputSchema,
            },
          ];
        });
        return { tools, notConnected };
      }),

    offers: (slug) => service(() => offered(slug)),

    readOnly: (slug) =>
      service(
        async () => (await offered(slug)) && (await describe(slug)).tags.includes(READ_ONLY_TAG),
      ),

    toolkit: (slug) =>
      service(async () => ((await offered(slug)) ? (await describe(slug)).toolkit : null)),

    deletes: (slug) =>
      service(async () => {
        if (!(await offered(slug))) return true;
        const { tags } = await describe(slug);
        return tags.includes(DESTRUCTIVE_TAG) || DELETING_NAME.test(slug);
      }),

    execute: (slug, args) =>
      service(async () => {
        const result = await (await current()).execute(slug, args);
        if (result.resultType === "completed") return { ok: true, data: result.data };
        return { ok: false, error: result.error || `${slug} failed` };
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// The Apps page

/** One app in the directory and whether the client has connected it. */
export interface AppConnection extends CatalogApp {
  connected: boolean;
  /** Not connected because its sign-in expired or was revoked at the app: reconnect it. */
  expired?: boolean;
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
  catalog = composioCatalog(apiKey, baseURL),
}: Omit<ComposioConnectorConfig, "clientId">) {
  const composio = composioClient(apiKey, baseURL);
  /** Every account the client has, for one app or all, in any state, across Composio's pages. */
  const accounts = async (clientId: string, slug?: string) => {
    const found: { id: string; status: string; toolkit: string }[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await composio.connectedAccounts.list({
        userIds: [appUserId(clientId)],
        ...(slug ? { toolkitSlugs: [slug] } : {}),
        ...(cursor ? { cursor } : {}),
      });
      found.push(
        ...page.items.map((a) => ({
          id: a.id,
          status: a.status,
          toolkit: (a.toolkit?.slug ?? "").toLowerCase(),
        })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  };
  /**
   * Revokes the account's access at the app (Google, Slack...), then deletes it: deleting alone
   * leaves the app's grant live. Only a working account can be revoked, so any other is only
   * deleted, and so is one Composio says it can't revoke (any 400). A revoke that fails otherwise
   * keeps the account, so a retry revokes it, unless `bestEffort`: a client that is going away
   * mustn't be held up by an app's outage.
   */
  const remove = async (
    account: { id: string; status: string },
    { bestEffort = false }: { bestEffort?: boolean } = {},
  ) => {
    if (account.status === "ACTIVE") {
      try {
        await composio.connectedAccounts.revoke(account.id);
      } catch (error) {
        const unrevokable =
          error instanceof ComposioConnectedAccountRevocationNotSupportedError ||
          error instanceof ComposioConnectedAccountNotRevokableError;
        if (!unrevokable && !bestEffort) throw error;
      }
    }
    await composio.connectedAccounts.delete(account.id);
  };
  const offered = async (toolkit: string) => {
    const slug = toolkit.toLowerCase();
    if (!(await catalog.offers(slug))) throw new AppServiceError(`Locus doesn't offer ${toolkit}`);
    return slug;
  };

  return {
    /** The catalog, the same for every client. */
    catalog: () => catalog.apps(),

    /**
     * Every app Locus offers, with whether the client has connected it. An app the client
     * connected that has since left the catalog is listed too, so it can still be disconnected.
     */
    async list(clientId: string): Promise<AppConnection[]> {
      const [apps, held] = await Promise.all([catalog.apps(), accounts(clientId)]);
      const active = new Set(held.filter((a) => a.status === "ACTIVE").map((a) => a.toolkit));
      const lapsed = new Set(
        held
          .filter((a) => a.status === "EXPIRED" || a.status === "REVOKED")
          .map((a) => a.toolkit)
          .filter((toolkit) => !active.has(toolkit)),
      );
      const listed: AppConnection[] = apps.map((app) => ({
        ...app,
        connected: active.has(app.toolkit),
        ...(lapsed.has(app.toolkit) ? { expired: true } : {}),
      }));
      const offeredSlugs = new Set(apps.map((app) => app.toolkit));
      for (const toolkit of active) {
        if (toolkit && !offeredSlugs.has(toolkit)) {
          listed.push({
            toolkit,
            name: toolkit,
            description:
              "Locus no longer offers this app, so the chat can't use it. Disconnect it here.",
            logo: "",
            categories: [],
            connected: true,
          });
        }
      }
      return listed;
    },

    /**
     * The app's own sign-in page; it comes back to `callbackUrl` when the person is done.
     * Accounts left half-connected or expired by earlier tries are removed first, so they can't
     * pile up where nobody can see or remove them.
     */
    async connect(clientId: string, toolkit: string, callbackUrl: string): Promise<string> {
      const slug = await offered(toolkit);
      for (const account of await accounts(clientId, slug)) {
        if (account.status !== "ACTIVE") await remove(account);
      }
      const session = await composio.create(appUserId(clientId), {
        toolkits: [slug],
        manageConnections: false,
        instant: false,
        sandbox: { enable: false },
      });
      const request = await session.authorize(slug, { callbackUrl });
      if (!request.redirectUrl)
        throw new AppServiceError(`Composio gave no sign-in link for ${toolkit}`);
      return request.redirectUrl;
    },

    /**
     * Removes every account the client has for the app, so none is left for the chat to use.
     * Any app the client holds an account for can be disconnected, offered or not.
     */
    async disconnect(clientId: string, toolkit: string): Promise<void> {
      const slug = toolkit.toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(slug)) throw new AppServiceError(`No app named ${toolkit}`);
      for (const account of await accounts(clientId, slug)) {
        await remove(account);
      }
    },

    /** Removes every account the client has, for any app, when the client itself goes. */
    async disconnectAll(clientId: string): Promise<void> {
      for (const account of await accounts(clientId)) {
        await remove(account, { bestEffort: true });
      }
    },
  };
}

export type AppConnections = ReturnType<typeof createComposioConnections>;
