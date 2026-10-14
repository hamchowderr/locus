/**
 * The agent server: the chat's API (`@locus/agent-api`) for every client of every agency, as
 * one long-running process. The web app forwards `/api/agent/*` here, so the browser's Better
 * Auth cookie arrives as it does on the web app, and the same checks decide who may act on
 * which client.
 */

import { createClient } from "@libsql/client";
import { createAgentApi } from "@locus/agent-api";
import {
  type AuthorizedClient,
  authorizeClient,
  createAuth,
  mintClientDbToken,
  resolveActiveClient,
  type SessionContext,
} from "@locus/auth";
import { type ConnectDeps, clientGhlSession } from "@locus/connect";
import { type ControlDb, DbSecretStore, openControlDb, provisionerFromEnv } from "@locus/db";
import * as schema from "@locus/db/control";
import { createLocusController } from "@locus/harness";
import { secretsFromEnv } from "@locus/secrets";
import type { MastraModelConfig } from "@mastra/core/llm";
import { LibSQLStore } from "@mastra/libsql";
import { refreshingClient } from "./refreshing-client.ts";

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
    /** A Mastra model id, e.g. `anthropic/claude-sonnet-5-5`; its key is the provider's usual variable. */
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
}

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
  return {
    db,
    session: async (headers) => {
      const current = await auth.api.getSession({ headers });
      if (!current) return null;
      const { id, userId, activeOrganizationId, activeLocationId } = current.session;
      return { id, userId, activeOrganizationId, activeLocationId };
    },
    connect: {
      db,
      secrets: secretsFromEnv(
        { localFile: ".data/secrets.json", encrypted: (cipher) => new DbSecretStore(db, cipher) },
        env,
      ),
      provisioner: provisionerFromEnv(".data/tenants", env),
      // The agent never runs the OAuth flow, so the redirect and scopes are never sent.
      ghl: { ...config.ghl, redirectUri: `${config.authUrl}/api/connect/crm/callback`, scopes: [] },
    },
    model: config.model,
    origin: new URL(config.authUrl).origin,
  };
}

/** The largest request body the agent reads; a chat message is far smaller. */
const MAX_BODY_BYTES = 1_000_000;

export function createHost({ db, session, connect, model, fetch, origin }: HostDeps) {
  // The member who last opened each client (keyed by Locus's client id, never the GHL location
  // id, which more than one agency can hold). Before any GHL or database token is minted for
  // the client, their staff check runs again, so a removed member or a suspended client stops
  // getting tokens even for a run already under way.
  const openedBy = new Map<string, SessionContext>();
  const authorized = async (clientId: string): Promise<AuthorizedClient> => {
    const ctx = openedBy.get(clientId);
    if (!ctx) throw new Error("this client has not been opened");
    return authorizeClient(db, ctx, clientId);
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
      openedBy.set(client.location.id, ctx);
      return {
        memberId: client.memberId,
        locationId: client.location.ghlLocationId,
        clientId: client.location.id,
      };
    },
    controllerFor: async ({ clientId, locationId }) => {
      const { location } = await authorized(clientId);
      const storage = new LibSQLStore({
        id: `client-${location.id}`,
        client: refreshingClient(
          async () =>
            createClient({
              url: connect.provisioner.url(location.tursoDbHostname),
              authToken: await mintClientDbToken(connect.provisioner, await authorized(clientId), {
                ttl: DB_TOKEN_TTL,
              }),
            }),
          { renewMs: DB_TOKEN_RENEW_MS },
          // Mastra types its client as its own SQLite interface, which libSQL's matches at
          // runtime but not under exactOptionalPropertyTypes.
        ) as unknown as StoreClient,
      });
      return createLocusController({
        model,
        locationId,
        session: async () => clientGhlSession(connect, await authorized(clientId)),
        storage,
        ...(fetch ? { fetch } : {}),
      });
    },
  });

  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") return new Response("ok");
      if (!request.body) return api.fetch(request);
      // The session cookie authenticates these, so only the web app's pages may send them, and
      // only as JSON: a cross-site form or text/plain post can't.
      const from = request.headers.get("origin");
      if (from && from !== origin) return Response.json({ error: "wrong origin" }, { status: 403 });
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return Response.json({ error: "send JSON" }, { status: 415 });
      }
      const body = await readCapped(request.body, MAX_BODY_BYTES);
      if (!body) return Response.json({ error: "too large" }, { status: 413 });
      return api.fetch(new Request(request, { body }));
    },
  };
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
