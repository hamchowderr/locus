/**
 * The Connections page's logic: which apps a client has connected (Gmail, Slack...), and
 * connecting or disconnecting them through Composio. The chat uses the same connections, since
 * both name the client's Composio user with `appUserId`.
 *
 * Every member who may work on a client can see its apps; only owners and admins change them.
 * The client is the session's, after the staff check, and never comes from the form.
 */

import {
  ClientAccessDenied,
  requireAgencyManager,
  resolveActiveClient,
  type SessionContext,
} from "@locus/auth";
import type { ControlDb } from "@locus/db";
import {
  type AppConnection,
  type AppConnections,
  AppServiceError,
  createComposioConnections,
} from "@locus/harness";

export { AppServiceError };

/** Otaku's Composio project, or null where connected apps aren't set up. */
export function appConnectionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AppConnections | null {
  return env.COMPOSIO_API_KEY ? createComposioConnections({ apiKey: env.COMPOSIO_API_KEY }) : null;
}

/** Owners and admins may change the agency's clients' apps; others see them only. */
async function manages(db: ControlDb, ctx: SessionContext): Promise<boolean> {
  try {
    await requireAgencyManager(db, ctx);
    return true;
  } catch (error) {
    if (error instanceof ClientAccessDenied) return false;
    throw error;
  }
}

export async function clientApps(
  db: ControlDb,
  ctx: SessionContext,
  connections: AppConnections,
): Promise<{ apps: AppConnection[]; manager: boolean }> {
  const client = await resolveActiveClient(db, ctx);
  const [apps, manager] = await Promise.all([
    connections.list(client.location.id),
    manages(db, ctx),
  ]);
  return { apps, manager };
}

/** The app's sign-in page for the session's client. Owners and admins only. */
export async function connectClientApp(
  db: ControlDb,
  ctx: SessionContext,
  connections: AppConnections,
  toolkit: string,
  callbackUrl: string,
): Promise<string> {
  const client = await resolveActiveClient(db, ctx);
  await requireAgencyManager(db, ctx);
  return connections.connect(client.location.id, toolkit, callbackUrl);
}

export async function disconnectClientApp(
  db: ControlDb,
  ctx: SessionContext,
  connections: AppConnections,
  toolkit: string,
): Promise<void> {
  const client = await resolveActiveClient(db, ctx);
  await requireAgencyManager(db, ctx);
  await connections.disconnect(client.location.id, toolkit);
}
