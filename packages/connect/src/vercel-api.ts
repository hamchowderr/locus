import type { ControlDb } from "@locus/db";
import { hostConnection } from "@locus/db/control";
import type { SecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import type { VercelGrant, VercelHttp } from "./vercel.ts";

// Internal: how sites.ts and publish.ts call Vercel on an agency's behalf. Not exported from
// the package.

export interface VercelCallDeps {
  db: ControlDb;
  secrets: SecretStore;
  http?: VercelHttp;
}

export interface VercelResult<T> {
  ok: boolean;
  status: number;
  body: T & { error?: { code?: string; message?: string } };
}

/** The agency's Vercel grant, from the secret store. */
export async function hostGrant(
  deps: VercelCallDeps,
  organizationId: string,
): Promise<VercelGrant> {
  const [host] = await deps.db
    .select()
    .from(hostConnection)
    .where(eq(hostConnection.organizationId, organizationId));
  if (host?.provider !== "vercel") {
    throw new ConnectError("Connect your Vercel team on the Integrations page first.");
  }
  const stored = await deps.secrets.get(host.secretRef);
  if (!stored) throw new ConnectError("Vercel needs to be connected again.");
  return JSON.parse(stored) as VercelGrant;
}

/** One Vercel API call as the agency's team (`teamId` added when the grant has one). */
export async function vercel<T>(
  deps: VercelCallDeps,
  grant: VercelGrant,
  method: string,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<VercelResult<T>> {
  const { fetch: f = fetch, apiBaseUrl = "https://api.vercel.com" } = deps.http ?? {};
  const url = new URL(path, apiBaseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  if (grant.teamId) url.searchParams.set("teamId", grant.teamId);
  const response = await f(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${grant.accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as VercelResult<T>["body"];
  return { ok: response.ok, status: response.status, body };
}

/** Vercel's own explanation when it has one; its messages are written for people. */
export function refused(result: VercelResult<unknown>, fallback: string): ConnectError {
  if (result.status === 401 || result.status === 403) {
    return new ConnectError(
      "Vercel refused. Reconnect Vercel on the Integrations page and allow access to all projects.",
    );
  }
  const message = result.body.error?.message;
  return new ConnectError(message ? `Vercel: ${message}` : fallback);
}
