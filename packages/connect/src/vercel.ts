import { requireAgencyManager, type SessionContext } from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { hostConnection } from "@locus/db/control";
import type { SecretStore } from "@locus/secrets";
import { ConnectError } from "./agency.ts";

// Contracts read from vercel.com/docs on 2026-10-10: the integration install flow, the
// `/v2/oauth/access_token` exchange, `GET /v2/teams/{teamId}` and `GET /v2/user`.

/** The Locus Vercel Integration (`locus-otaku`). */
export interface VercelIntegrationConfig {
  slug: string;
  clientId: string;
  clientSecret: string;
  /** Exactly the Redirect URL in the Integration Console. */
  redirectUri: string;
}

export interface VercelHttp {
  fetch?: typeof fetch;
  /** `https://api.vercel.com`. */
  apiBaseUrl?: string;
}

export interface VercelConnectDeps {
  db: ControlDb;
  secrets: SecretStore;
  vercel: VercelIntegrationConfig;
  http?: VercelHttp;
  now?: () => number;
}

/** What Locus keeps of a Vercel grant: in the secret store, sealed, never in a row. */
export interface VercelGrant {
  accessToken: string;
  /** `null` for a personal account; then API calls go without `teamId`. */
  teamId: string | null;
  userId: string;
  configurationId: string;
}

/** Where an agency's Vercel grant lives in the secret store. */
export const vercelSecretRef = (organizationId: string) => `/locus/vercel/${organizationId}`;

/** Where an owner or admin installs the integration on their team. */
export function vercelInstallUrl(config: VercelIntegrationConfig, state: string): string {
  const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(config.slug)}/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Connects the session's agency to the Vercel team it installed the integration on, with the
 * `code` from Vercel's redirect (valid 30 minutes, usable once). The token is long-lived and
 * has no refresh; it is sealed in the secret store, and the row keeps only the team.
 */
export async function connectVercel(
  deps: VercelConnectDeps,
  ctx: SessionContext,
  input: { code: string },
): Promise<{ teamId: string; accountName: string }> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const grant = await exchangeVercelCode(deps, input.code);
  const accountName = await vercelAccountName(deps, grant);

  const secretRef = vercelSecretRef(organizationId);
  await deps.secrets.set(secretRef, JSON.stringify(grant));
  const values = {
    provider: "vercel" as const,
    // Personal accounts have no team; their user id is the scope instead.
    teamId: grant.teamId ?? grant.userId,
    accountName,
    secretRef,
    connectedAt: new Date(deps.now?.() ?? Date.now()),
  };
  await deps.db
    .insert(hostConnection)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: hostConnection.organizationId, set: values });
  return { teamId: values.teamId, accountName };
}

async function exchangeVercelCode(deps: VercelConnectDeps, code: string): Promise<VercelGrant> {
  const { fetch: f = fetch, apiBaseUrl = "https://api.vercel.com" } = deps.http ?? {};
  const response = await f(`${apiBaseUrl}/v2/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.vercel.clientId,
      client_secret: deps.vercel.clientSecret,
      code,
      redirect_uri: deps.vercel.redirectUri,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    installation_id?: string;
    user_id?: string;
    team_id?: string | null;
  };
  if (!response.ok || !body.access_token || !body.user_id || !body.installation_id) {
    throw new ConnectError("Vercel didn't accept that installation. Try connecting again.");
  }
  return {
    accessToken: body.access_token,
    teamId: body.team_id ?? null,
    userId: body.user_id,
    configurationId: body.installation_id,
  };
}

/** The team's name (or slug), or the personal account's username, for display. */
async function vercelAccountName(deps: VercelConnectDeps, grant: VercelGrant): Promise<string> {
  const { fetch: f = fetch, apiBaseUrl = "https://api.vercel.com" } = deps.http ?? {};
  const headers = { authorization: `Bearer ${grant.accessToken}` };
  if (grant.teamId) {
    const id = encodeURIComponent(grant.teamId);
    const response = await f(`${apiBaseUrl}/v2/teams/${id}?teamId=${id}`, { headers });
    if (!response.ok) throw new ConnectError("Vercel didn't show the team. Try connecting again.");
    const team = (await response.json()) as { name?: string | null; slug?: string };
    return team.name || team.slug || grant.teamId;
  }
  const response = await f(`${apiBaseUrl}/v2/user`, { headers });
  if (!response.ok) throw new ConnectError("Vercel didn't show the account. Try connecting again.");
  const { user } = (await response.json()) as {
    user?: { username?: string; name?: string | null };
  };
  return user?.name || user?.username || grant.userId;
}
