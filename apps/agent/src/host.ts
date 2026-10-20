/**
 * The agent server: the chat's API (`@locus/agent-api`) for every client of every agency, as
 * one long-running process. The web app forwards `/api/agent/*` here, so the browser's Better
 * Auth cookie arrives as it does on the web app, and the same checks decide who may act on
 * which client.
 */

import { createClient } from "@libsql/client";
import { clientWorkThreads, createAgentApi, KIT_STREAM_BODY_LIMIT } from "@locus/agent-api";
import {
  type AuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  chatKitKey,
  chatKitSessionId,
  createAuth,
  mintClientDbToken,
  resolveActiveClient,
  type SessionContext,
} from "@locus/auth";
import { imagesFromEnv } from "@locus/builder";
import {
  activeSiteIdForSession,
  createSiteBuilder,
  openClientDb,
  remotePublish,
  remoteSiteRuntimes,
  SITE_ID_KEY,
  type SiteBuilderDeps,
} from "@locus/builder/host";
import { type ConnectDeps, clientGhlSession, siteCrm } from "@locus/connect";
import { type ControlDb, DbSecretStore, openControlDb, provisionerFromEnv } from "@locus/db";
import * as schema from "@locus/db/control";
import { session as authSession } from "@locus/db/control";
import { type AppConnector, createComposioConnector, createLocusController } from "@locus/harness";
import { deriveSecretsSubkey, secretsFromEnv } from "@locus/secrets";
import type { MastraModelConfig } from "@mastra/core/llm";
import { LibSQLStore } from "@mastra/libsql";
import { eq } from "drizzle-orm";
import { refreshingClient } from "./refreshing-client.ts";
import { SITE_UPLOAD_PATH, type SiteUploadDeps, siteUploads } from "./site-uploads.ts";

export const PREFIX = "/api/agent";

type StoreClient = Extract<
  ConstructorParameters<typeof LibSQLStore>[0],
  { client: unknown }
>["client"];

/** Client database tokens live this long; the store renews its token well before. */
const DB_TOKEN_TTL = "2h";
const DB_TOKEN_RENEW_MS = 60 * 60 * 1000;

export class NotConfigured extends Error {
  constructor(name: string) {
    super(`Locus agent is not configured: ${name} is not set`);
    this.name = "NotConfigured";
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new NotConfigured(name);
  return value;
}

/** Everything the agent reads from the environment, checked once at start. */
export function configFromEnv(env: Env = process.env) {
  return {
    controlDbUrl: required(env, "LOCUS_CONTROL_DB_URL"),
    controlDbToken: env.LOCUS_CONTROL_DB_TOKEN,
    authUrl: required(env, "BETTER_AUTH_URL"),
    authSecret: required(env, "BETTER_AUTH_SECRET"),
    ghl: {
      clientId: required(env, "GHL_CLIENT_ID"),
      clientSecret: required(env, "GHL_CLIENT_SECRET"),
      appId: required(env, "GHL_APP_ID"),
    },
    /**
     * A Mastra model id, e.g. `anthropic/claude-sonnet-5-5`, whose key is the provider's usual
     * variable; or `scripted` for a fixed reply that needs no key (see `scripted-model.ts`).
     */
    model: required(env, "LOCUS_AGENT_MODEL"),
  };
}

export interface HostDeps {
  db: ControlDb;
  /** The signed-in user's session from a request's headers, as Better Auth reads it. */
  session: (headers: Headers) => Promise<SessionContext | null>;
  connect: ConnectDeps;
  model: MastraModelConfig;
  /** GHL's API; tests pass a fake. */
  fetch?: typeof fetch;
  /** The web app's origin, the only one whose pages may post to the agent. */
  origin: string;
  /** How often an open event stream re-checks access; tests shorten it. */
  streamCheckMs?: number;
  /** Where a request the agent failed is reported; the process's error log by default. */
  logError?: (message: string, error?: unknown) => void;
  /**
   * The site builder's mode and tools, added to every client's controller. Its sandboxes are
   * driven through the web app (`remoteSiteRuntimes`), which can reach Vercel Sandbox, and its
   * saved versions are published through it too (`remotePublish`). Null leaves the builder out.
   */
  siteBuilder?: Omit<SiteBuilderDeps, "db"> | null;
  /**
   * Each client's connected apps (Gmail, Slack...), built for that client. Null, the default,
   * leaves app tools out of the chat.
   */
  apps?: ((clientId: string) => AppConnector) | null;
  /**
   * Bigger files members upload on app-style sites, sent here with a ticket because Vercel
   * caps a request at 4.5 MB. Null, the default, leaves the route out.
   */
  siteUploads?: SiteUploadDeps | null;
}

/** The agent holds no sandbox credentials: every sandbox goes through the web app. */
const NO_LOCAL_SANDBOXES: SiteBuilderDeps["runtimes"] = () => ({
  open: async () => {
    throw new Error("the agent server opens sandboxes only through the web app");
  },
});

export function hostDepsFromEnv(env: Env = process.env): HostDeps {
  const config = configFromEnv(env);
  const db = openControlDb(config.controlDbUrl, config.controlDbToken);
  const auth = createAuth({
    db,
    schema,
    baseURL: config.authUrl,
    secret: config.authSecret,
    // The agent signs nobody up and resets no password; it only reads sessions.
    sendEmail: async () => {
      throw new Error("the agent server sends no email");
    },
  });
  const kitSession = sessionFromKitToken(db, chatKitKey(config.authSecret));
  const provisioner = provisionerFromEnv(".data/tenants", env);
  const secrets = secretsFromEnv(
    { localFile: ".data/secrets.json", encrypted: (cipher) => new DbSecretStore(db, cipher) },
    env,
  );
  // The agent never runs the OAuth flow, so the redirect and scopes are never sent.
  const ghl = {
    ...config.ghl,
    redirectUri: `${config.authUrl}/api/connect/crm/callback`,
    scopes: [],
  };
  const webApp = {
    url: config.authUrl,
    authSecret: config.authSecret,
    // Staging's web app is a protected Vercel preview; production's domain isn't.
    ...(env.LOCUS_WEB_VERCEL_BYPASS ? { vercelBypass: env.LOCUS_WEB_VERCEL_BYPASS } : {}),
  };
  return {
    db,
    session: async (headers) => {
      // The chat kit's proxy (on the web app) vouches with a token naming the session.
      const vouched = await kitSession(headers);
      if (vouched !== undefined) return vouched;
      const current = await auth.api.getSession({ headers });
      if (!current) return null;
      const { id, userId, activeOrganizationId, activeLocationId } = current.session;
      return { id, userId, activeOrganizationId, activeLocationId };
    },
    connect: {
      db,
      secrets,
      provisioner,
      ghl,
    },
    model: config.model,
    origin: new URL(config.authUrl).origin,
    siteBuilder: {
      openClientDb: (client) => openClientDb(provisioner, client),
      runtimes: NO_LOCAL_SANDBOXES,
      openRuntime: remoteSiteRuntimes(webApp),
      images: imagesFromEnv(env),
      // Publishing needs the GitHub App, which only the web app holds: versions saved here
      // are published through it.
      publish: null,
      publishVersion: remotePublish(webApp),
      locusUrl: config.authUrl,
    },
    // Sites' bigger uploads: the files and ticket keys are derived from the secrets key.
    siteUploads: env.LOCUS_SECRETS_KEY
      ? {
          db,
          secrets,
          ghl,
          filesKey: deriveSecretsSubkey("locus/site-files", env),
          ticketKey: deriveSecretsSubkey("locus/site-file-ticket", env),
          ipHashKey: deriveSecretsSubkey("locus/site-lead-ip", env),
        }
      : null,
    // Connected apps are on once Otaku's Composio key is set.
    apps: env.COMPOSIO_API_KEY
      ? (clientId) => createComposioConnector({ apiKey: env.COMPOSIO_API_KEY as string, clientId })
      : null,
  };
}

/**
 * The session a chat kit token names (see `chatKitSessionId`), as long as it is still signed in;
 * null for a bad or stale token; undefined when the request carries no token at all.
 */
export function sessionFromKitToken(db: ControlDb, key: string) {
  return async (headers: Headers): Promise<SessionContext | null | undefined> => {
    const bearer = headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    if (!bearer) return undefined;
    const id = chatKitSessionId(bearer, key);
    if (!id) return null;
    const [row] = await db
      .select({
        id: authSession.id,
        userId: authSession.userId,
        expiresAt: authSession.expiresAt,
        activeOrganizationId: authSession.activeOrganizationId,
        activeLocationId: authSession.activeLocationId,
      })
      .from(authSession)
      .where(eq(authSession.id, id));
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    const { expiresAt: _expiresAt, ...ctx } = row;
    return ctx;
  };
}

/** The largest request body the agent reads; a chat message is far smaller. */
const MAX_BODY_BYTES = 1_000_000;

/** The chat kit's stream route, whose messages may carry attachments. */
const KIT_STREAM_PATH = `${PREFIX}/kit/agent-controller/stream`;

/** The run request-context key naming the session a run acts for. Set here, never by the browser. */
export const RUN_SESSION_KEY = "locus.session";

/** An open event stream re-checks access at least this often, and before events after a gap. */
const STREAM_CHECK_MS = 5_000;

export function createHost({
  db,
  session,
  connect,
  model,
  fetch,
  origin,
  streamCheckMs = STREAM_CHECK_MS,
  logError = (message, error) =>
    error === undefined ? console.error(message) : console.error(message, error),
  siteBuilder = null,
  apps = null,
  siteUploads: uploadDeps = null,
}: HostDeps) {
  const uploads = uploadDeps ? siteUploads(uploadDeps, logError) : null;
  // Per client, the sessions that opened it, newest last: its database token is the client's,
  // not one run's, so any of them still allowed in will do.
  const openers = new Map<string, Map<string, SessionContext>>();
  const opened = new WeakMap<Request, { ctx: SessionContext; clientId: string }>();

  /**
   * The staff check again, for the session a request or run came with (as it was then, so a
   * switch of agency in another tab changes nothing here): still signed in, still a member
   * allowed this client.
   */
  const authorizedFor = async (ctx: SessionContext, clientId: string) => {
    const [row] = await db
      .select({ expiresAt: authSession.expiresAt })
      .from(authSession)
      .where(eq(authSession.id, ctx.id));
    if (!row || row.expiresAt.getTime() <= Date.now()) throw new ClientAccessDenied("signed out");
    return authorizeClient(db, ctx, clientId);
  };

  /** For the client's own database: any session that opened it and may still. */
  const anyAuthorized = async (clientId: string) => {
    const byId = openers.get(clientId) ?? new Map<string, SessionContext>();
    for (const [id, ctx] of [...byId].reverse()) {
      try {
        return await authorizedFor(ctx, clientId);
      } catch (error) {
        if (!(error instanceof ClientAccessDenied)) throw error;
        byId.delete(id);
      }
    }
    throw new ClientAccessDenied("nobody may open this client now");
  };

  const api = createAgentApi({
    prefix: PREFIX,
    authorize: async (request) => {
      const ctx = await session(request.headers);
      if (!ctx) return null;
      let client: AuthorizedClient;
      try {
        client = await resolveActiveClient(db, ctx);
      } catch {
        return null;
      }
      const clientId = client.location.id;
      const byId = openers.get(clientId) ?? new Map<string, SessionContext>();
      byId.delete(ctx.id);
      byId.set(ctx.id, ctx);
      openers.set(clientId, byId);
      opened.set(request, { ctx, clientId });
      return { memberId: client.memberId, locationId: client.location.ghlLocationId, clientId };
    },
    // Each run carries the session it acts for, so its GHL calls are checked against that
    // member, not whoever used the client last.
    requestContext: async (request) => {
      const run = opened.get(request);
      if (!run) return {};
      const context: Record<string, unknown> = { [RUN_SESSION_KEY]: run.ctx };
      if (siteBuilder) {
        // The site the member chose on the Sites page, if it is still this client's. The
        // builder checks it again on every tool call.
        try {
          const client = await authorizedFor(run.ctx, run.clientId);
          const siteId = await activeSiteIdForSession(db, run.ctx, client);
          if (siteId) context[SITE_ID_KEY] = siteId;
        } catch (error) {
          // Without a site the builder refuses its tools; other requests carry on.
          if (!(error instanceof ClientAccessDenied)) {
            console.error("Reading the active site failed:", error);
          }
        }
      }
      return context;
    },
    controllerFor: async ({ clientId, locationId }) => {
      const { location } = await anyAuthorized(clientId);
      const storage = new LibSQLStore({
        id: `client-${location.id}`,
        client: refreshingClient(
          async () =>
            createClient({
              url: connect.provisioner.url(location.tursoDbHostname),
              authToken: await mintClientDbToken(
                connect.provisioner,
                await anyAuthorized(clientId),
                {
                  ttl: DB_TOKEN_TTL,
                },
              ),
            }),
          {
            renewMs: DB_TOKEN_RENEW_MS,
            // Nobody may open the client any more: stop using the token it still holds.
            revoked: (error) => error instanceof ClientAccessDenied,
          },
          // Mastra types its client as its own SQLite interface, which libSQL's matches at
          // runtime but not under exactOptionalPropertyTypes.
        ) as unknown as StoreClient,
      });
      /** The staff check for the session a run acts for. */
      const runClient = async (requestContext?: { get: (key: string) => unknown }) => {
        const ctx = requestContext?.get(RUN_SESSION_KEY) as SessionContext | undefined;
        if (!ctx?.id) throw new ClientAccessDenied("run has no session");
        return authorizedFor(ctx, clientId);
      };
      const builder = siteBuilder
        ? createSiteBuilder(
            {
              ...siteBuilder,
              db,
              // The builder reads the client's calendars as the member behind each tool call.
              crm: (client) =>
                siteCrm(async () => ({
                  session: await clientGhlSession(connect, client),
                  ...(connect.http ? { http: connect.http } : {}),
                })),
            },
            {
              client: await anyAuthorized(clientId),
              requester: (requestContext) =>
                runClient(requestContext as { get: (key: string) => unknown } | undefined),
            },
          )
        : null;
      // One connector per client, so its Composio session is reused across runs.
      const clientApps = apps ? apps(clientId) : null;
      // The main chat hands longer work to threads of their own (`start_thread`), which run in
      // the background and report back. Its result is the new thread's id and title only.
      const workThreads = clientWorkThreads(storage);
      const controller = await createLocusController({
        model,
        locationId,
        session: async (requestContext) =>
          clientGhlSession(connect, await runClient(requestContext)),
        storage,
        ...(fetch ? { fetch } : {}),
        ...(clientApps
          ? {
              // The same staff check as GHL, before any app is reached.
              apps: async (requestContext) => {
                await runClient(requestContext);
                return clientApps;
              },
            }
          : {}),
        tools: { ...builder?.tools, [workThreads.tool.id]: workThreads.tool },
        ownTextTools: [...(builder?.ownTextTools ?? []), workThreads.tool.id],
        ...(builder ? { modes: builder.modes, processors: builder.processors } : {}),
      });
      workThreads.attach(controller);
      return controller;
    },
  });

  /**
   * An event stream, cut off once the member it was opened for loses access. `cut` also stops
   * the run the stream belongs to, so nothing keeps working (or waits on an approval nobody
   * can give) for a member who may no longer act.
   */
  const guardStream = (request: Request, response: Response, cut?: () => void) => {
    const stream = opened.get(request);
    const events = response.headers.get("content-type")?.startsWith("text/event-stream");
    if (!events || !stream || !response.body) return response;
    // A member who loses access must stop receiving the client's live chat too. The chat
    // kit's runs stream on the response to a POST, so this covers every method.
    return new Response(
      guarded(response.body, () => authorizedFor(stream.ctx, stream.clientId), streamCheckMs, cut),
      response,
    );
  };

  const serve = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    // Ticketed, cookie-free and from any site's page: before the origin and JSON rules below.
    if (pathname === SITE_UPLOAD_PATH && uploads) return uploads(request);
    if (request.method === "GET" || request.method === "HEAD") {
      return guardStream(request, await api.fetch(request));
    }
    // The session cookie authenticates these, so only the web app's pages may send them, and
    // a body only as JSON: a cross-site form or text/plain post can't.
    const from = request.headers.get("origin");
    if (from && from !== origin) return Response.json({ error: "wrong origin" }, { status: 403 });
    const max = pathname === KIT_STREAM_PATH ? KIT_STREAM_BODY_LIMIT : MAX_BODY_BYTES;
    const body = request.body ? await readCapped(request.body, max) : Buffer.alloc(0);
    if (!body) return Response.json({ error: "too large" }, { status: 413 });
    if (body.length > 0 && !request.headers.get("content-type")?.startsWith("application/json")) {
      return Response.json({ error: "send JSON" }, { status: 415 });
    }
    // Aborting the request is how a run streamed on its response is stopped.
    const cut = new AbortController();
    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.any([request.signal, cut.signal]),
      ...(body.length > 0 ? { body } : {}),
    });
    return guardStream(forwarded, await api.fetch(forwarded), () => cut.abort());
  };

  return {
    /**
     * Serves a request. A failure is logged with its cause (Mastra's own logger is off), and
     * the caller gets only a generic error.
     */
    async fetch(request: Request): Promise<Response> {
      const what = `${request.method} ${new URL(request.url).pathname}`;
      let response: Response;
      try {
        response = await serve(request);
      } catch (error) {
        logError(`Agent request failed: ${what}`, error);
        return Response.json({ error: "something went wrong" }, { status: 500 });
      }
      return reportFailure(response, what, logError);
    },
  };
}

/** How much of a failed response's body is logged. */
const MAX_LOGGED_BODY = 2_000;

/**
 * The response, unless it is a server error: then its cause (the first part of its body) is
 * logged and the caller gets a generic error in its place. Event streams pass through as is.
 */
export async function reportFailure(
  response: Response,
  what: string,
  logError: (message: string, error?: unknown) => void,
): Promise<Response> {
  if (
    response.status < 500 ||
    response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    return response;
  }
  let cause = "";
  try {
    const reader = response.body?.getReader();
    while (reader && cause.length < MAX_LOGGED_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      cause += new TextDecoder().decode(value, { stream: true });
    }
    await reader?.cancel();
  } catch (error) {
    cause = `(body unreadable: ${error})`;
  }
  logError(
    `Agent request failed: ${what} answered ${response.status}: ${cause.slice(0, MAX_LOGGED_BODY)}`,
  );
  return Response.json({ error: "something went wrong" }, { status: response.status });
}

/**
 * The stream, while `check` passes. It is checked before passing on what arrives once the last
 * check is `everyMs` old, and on a timer while nothing arrives, so a member who loses access
 * stops receiving within about `everyMs`. The stream ends, and `denied` is called, when a check
 * fails.
 */
function guarded(
  body: ReadableStream<Uint8Array>,
  check: () => Promise<unknown>,
  everyMs: number,
  denied: () => void = () => {},
) {
  const reader = body.getReader();
  let checkedAt = Date.now();
  let checking: Promise<boolean> | undefined;
  let finished = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  /** Ends everything once, whatever ends it first; never throws. */
  const stop = (error?: unknown) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try {
      if (error === undefined) controller.close();
      else controller.error(error);
    } catch {}
    reader.cancel().catch(() => {});
  };

  /** Ends the stream because a check failed. */
  const refuse = () => {
    if (finished) return;
    stop();
    denied();
  };

  /** One check at a time, shared by the timer and the reader. */
  const stillAllowed = () => {
    checking ??= check()
      .then(
        () => {
          checkedAt = Date.now();
          return true;
        },
        () => false,
      )
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      timer = setInterval(() => {
        if (finished || Date.now() - checkedAt < everyMs) return;
        void stillAllowed().then((ok) => {
          if (!ok) refuse();
        });
      }, everyMs);
      timer.unref?.();
    },
    async pull() {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        stop(error);
        return;
      }
      if (finished) return;
      if (next.done) return stop();
      if (Date.now() - checkedAt >= everyMs && !(await stillAllowed())) return refuse();
      if (finished) return;
      controller.enqueue(next.value);
    },
    cancel() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      reader.cancel().catch(() => {});
    },
  });
}

/** The whole stream, or null as soon as it passes `max` bytes. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
