import {
  type AgentToWebClaims,
  agentToWebKey,
  authorizeClient,
  ClientAccessDenied,
  verifyAgentToWebToken,
} from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { member } from "@locus/db/control";
import { handleSandboxRequest, type RuntimeProvider } from "@locus/sandbox";
import { eq } from "drizzle-orm";
import { clientSite, siteRuntimeKey } from "./site-builder.ts";

/**
 * `/api/internal/sandbox`: lets a Locus backend off Vercel (the agent server) drive a site's
 * sandbox through this app, which can authenticate to Vercel Sandbox with its deployment's OIDC
 * token. No credential travels: the caller sends a short-lived agent-to-web token (keyed from
 * `BETTER_AUTH_SECRET`) naming the member and client, and only the site id in the body.
 *
 * Before any sandbox is opened, on every call: the token is verified; the member is loaded and
 * must belong to the token's agency; the staff check runs for that member and client
 * (`authorizeClient`: the client's status, and a restricted member's client list); and the site
 * must be that client's. The sandbox key is then derived as the in-process builder does
 * (`siteRuntimeKey`). A bad token is 404; a refused member or site is 403, alike.
 */
export interface SandboxRpcDeps {
  db: ControlDb;
  provider: RuntimeProvider;
  /** `BETTER_AUTH_SECRET`. */
  authSecret: string;
  now?: () => number;
}

/** The sandbox key for `siteId` if the token's member may work on it now; null if refused. */
export async function sandboxKeyFor(
  db: ControlDb,
  claims: AgentToWebClaims,
  siteId: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ userId: member.userId, organizationId: member.organizationId })
      .from(member)
      .where(eq(member.id, claims.memberId));
    if (!row || row.organizationId !== claims.organizationId) return null;
    const client = await authorizeClient(
      db,
      { id: "agent-to-web", userId: row.userId, activeOrganizationId: row.organizationId },
      claims.locationId,
    );
    if (client.memberId !== claims.memberId) return null;
    await clientSite(db, client, siteId);
    return siteRuntimeKey(client, siteId);
  } catch (error) {
    if (error instanceof ClientAccessDenied) return null;
    throw error;
  }
}

export function sandboxRpcHandler(deps: SandboxRpcDeps): (request: Request) => Promise<Response> {
  const key = agentToWebKey(deps.authSecret);
  return (request) =>
    handleSandboxRequest(request, {
      provider: deps.provider,
      authenticate: (token) => verifyAgentToWebToken(token, key, deps.now?.() ?? Date.now()),
      sandboxKey: (claims, siteId) => sandboxKeyFor(deps.db, claims, siteId),
    });
}
