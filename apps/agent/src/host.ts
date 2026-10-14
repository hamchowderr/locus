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
  };
}

export function createHost({ db, session, connect, model, fetch }: HostDeps) {
  // The latest staff-checked client for each GHL location. Its GHL token and database token
  // carry no user identity, so any member's check will do; every request is checked again.
  const clients = new Map<string, AuthorizedClient>();

  const api = createAgentApi({
    prefix: PREFIX,
    authorize: async (request) => {
      const ctx = await session(request.headers);
      if (!ctx) return null;
      try {
        const client = await resolveActiveClient(db, ctx);
        clients.set(client.location.ghlLocationId, client);
        return { memberId: client.memberId, locationId: client.location.ghlLocationId };
      } catch {
        return null;
      }
    },
    controllerFor: async (locationId) => {
      const client = () => {
        const current = clients.get(locationId);
        if (!current) throw new Error(`no authorized client for ${locationId}`);
        return current;
      };
      const { location } = client();
      const storage = new LibSQLStore({
        id: `client-${location.id}`,
        client: refreshingClient(
          async () =>
            createClient({
              url: connect.provisioner.url(location.tursoDbHostname),
              authToken: await mintClientDbToken(connect.provisioner, client(), {
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
        session: () => clientGhlSession(connect, client()),
        storage,
        ...(fetch ? { fetch } : {}),
      });
    },
  });

  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") return new Response("ok");
      return api.fetch(request);
    },
  };
}
