import { type AuthorizedClient, agentToWebKey, verifyAgentToWebToken } from "@locus/auth";
import { PublishError } from "@locus/builder";
import type { PublishDeps } from "@locus/connect";
import type { ControlDb, TenantDb } from "@locus/db";
import { SiteWorkspace, WorkspaceError } from "@locus/studio";
import { siteClientFor } from "./sandbox-rpc.ts";
import { publishHook } from "./site-builder.ts";

/**
 * `/api/internal/publish`: lets a Locus backend without the GitHub App (the agent server)
 * publish a version saved in the chat, through this app, which holds the App. Like
 * `/api/internal/sandbox`, the caller sends only a short-lived agent-to-web token naming the
 * member and client, and the site and version ids in the body (`remotePublish`).
 *
 * On every call: the token is verified; the member, staff check and site are checked as for the
 * sandbox (`siteClientFor`); the version's files are read from the client's own database here,
 * never taken from the caller; and they are published as the in-process builder does
 * (`publishHook`), so a site without a repository is left alone. A bad token is 404 and a
 * refused member or site 403; a refusal written for the person is 422 `{ error }`.
 */
export interface PublishRpcDeps {
  db: ControlDb;
  /** Only ever called with a freshly authorized client. */
  openClientDb: (client: AuthorizedClient) => Promise<TenantDb>;
  publish: () => PublishDeps;
  /** `BETTER_AUTH_SECRET`. */
  authSecret: string;
  /** This deployment's public address (`SiteBuilderDeps.locusUrl`). */
  locusUrl: string;
  now?: () => number;
}

/** A publish call's body is two ids; anything much bigger isn't one. */
const MAX_BODY_BYTES = 4096;
const MAX_ID_LENGTH = 200;

const json = (body: unknown, status = 200) => Response.json(body, { status });

function idOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

async function readIds(request: Request): Promise<{ siteId: string; versionId: string } | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text) as { siteId?: unknown; versionId?: unknown };
    const siteId = idOf(body?.siteId);
    const versionId = idOf(body?.versionId);
    return siteId && versionId ? { siteId, versionId } : null;
  } catch {
    return null;
  }
}

export function publishRpcHandler(deps: PublishRpcDeps): (request: Request) => Promise<Response> {
  const key = agentToWebKey(deps.authSecret);
  return async (request) => {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    const claims = token ? verifyAgentToWebToken(token, key, deps.now?.() ?? Date.now()) : null;
    if (!claims) return new Response("Not Found", { status: 404 });
    const ids = await readIds(request);
    if (!ids) return json({ error: "bad request" }, 400);
    const client = await siteClientFor(deps.db, claims, ids.siteId);
    if (!client) return json({ error: "forbidden" }, 403);

    const db = await deps.openClientDb(client);
    try {
      const workspace = new SiteWorkspace(db, ids.siteId);
      let version: Awaited<ReturnType<SiteWorkspace["getVersion"]>>;
      try {
        version = await workspace.getVersion(ids.versionId);
      } catch (error) {
        if (error instanceof WorkspaceError) return json({ error: "no such version" }, 404);
        throw error;
      }
      const files = await workspace.versionFiles(ids.versionId);
      const hook = publishHook(deps.db, deps.publish, client, ids.siteId, deps.locusUrl);
      return json((await hook(version, files)) ?? {});
    } catch (error) {
      if (error instanceof PublishError) return json({ error: error.message }, 422);
      console.error("Publishing a site version for the agent server failed", error);
      return json({ error: "publish failed" }, 500);
    } finally {
      db.$client.close();
    }
  };
}
