/**
 * The Apps page's logic: which apps a client has connected (Gmail, Slack...), and
 * connecting or disconnecting them through Composio. The chat uses the same connections, since
 * both name the client's Composio user with `appUserId`.
 *
 * Every member who may work on a client can see its apps; only owners and admins change them.
 * The client is the session's, after the staff check, and never comes from the form.
 */

import {
  type AuthorizedClient,
  ClientAccessDenied,
  requireAgencyManager,
  resolveActiveClient,
  type SessionContext,
} from "@locus/auth";
import { openClientDb } from "@locus/builder/host";
import {
  type ControlDb,
  clearAppAccess,
  isStoredAppAccess,
  provisionerFromEnv,
  readAppAccess,
  type TenantDb,
  writeAppAccess,
} from "@locus/db";
import {
  type AppAccess,
  type AppConnection,
  type AppConnections,
  AppServiceError,
  accessOf,
  createComposioConnections,
} from "@locus/harness";
import { configured } from "./connect.ts";

export { AppServiceError };

/** Opens the client's own database, after the staff check (`openClientDb`). */
export type ClientDbOpener = (client: AuthorizedClient) => Promise<TenantDb>;

/** The deployment's client databases. */
export function clientDbFromEnv(): ClientDbOpener {
  const provisioner = configured(() => provisionerFromEnv(".data/tenants"));
  return (client) => openClientDb(provisioner, client);
}

/** An app on the Apps page: whether it's connected and, if so, how the chat may use it. */
export interface ClientApp extends AppConnection {
  access: AppAccess;
}

/** A setting the person can fix by choosing again. */
export class AppAccessInputError extends Error {
  override name = "AppAccessInputError";
}

async function withClientDb<T>(
  open: ClientDbOpener,
  client: AuthorizedClient,
  run: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const tenant = await open(client);
  try {
    return await run(tenant);
  } finally {
    tenant.$client.close();
  }
}

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
  openDb: ClientDbOpener,
): Promise<{ apps: ClientApp[]; manager: boolean }> {
  const client = await resolveActiveClient(db, ctx);
  const [apps, manager] = await Promise.all([
    connections.list(client.location.id),
    manages(db, ctx),
  ]);
  // The client's own database is opened only when there's a connected app to show a setting for.
  const settings = apps.some((app) => app.connected)
    ? await withClientDb(openDb, client, readAppAccess)
    : {};
  return {
    apps: apps.map((app) => ({ ...app, access: accessOf(settings, app.toolkit) })),
    manager,
  };
}

/**
 * How the chat may use one of the session's client's apps. Owners and admins only; the client
 * is the session's, never the form's. The agent reads it on every call (see `apps.ts` in
 * `@locus/harness`), so it takes effect on the chat's next step.
 */
export async function setClientAppAccess(
  db: ControlDb,
  ctx: SessionContext,
  openDb: ClientDbOpener,
  toolkit: string,
  access: string,
): Promise<void> {
  const client = await resolveActiveClient(db, ctx);
  await requireAgencyManager(db, ctx);
  const slug = toolkit.toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw new AppAccessInputError(`No app named ${toolkit}`);
  if (!isStoredAppAccess(access)) throw new AppAccessInputError("Choose one of the settings.");
  await withClientDb(openDb, client, (tenant) => writeAppAccess(tenant, slug, access, ctx.userId));
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

/** Disconnects the app, and forgets its setting, so connecting it again starts from the default. */
export async function disconnectClientApp(
  db: ControlDb,
  ctx: SessionContext,
  connections: AppConnections,
  openDb: ClientDbOpener,
  toolkit: string,
): Promise<void> {
  const client = await resolveActiveClient(db, ctx);
  await requireAgencyManager(db, ctx);
  await connections.disconnect(client.location.id, toolkit);
  await withClientDb(openDb, client, (tenant) => clearAppAccess(tenant, toolkit.toLowerCase()));
}
