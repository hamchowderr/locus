import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import {
  type ControlDb,
  listSiteTables,
  listSiteUsers,
  openSiteDb,
  readSiteRows,
  type SiteRows,
  type SiteTable,
  type SiteUser,
  siteDbName,
  type TenantProvisioner,
} from "@locus/db";
import { site, siteBackend } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import { audit } from "./sites.ts";

// The backend of an app-style site: its own Turso database on Otaku's account, separate from
// the client's database, for the records the site's app keeps (member logins, bookings, its
// own tables). Plain websites never get one. Every call is scoped by the session's client,
// and every token is minted after that check and names only the site's database.

export interface SiteBackendDeps {
  db: ControlDb;
  provisioner: TenantProvisioner;
}

export type SiteBackendRow = typeof siteBackend.$inferSelect;

/** How long a dashboard token lives: one page load. */
const DASHBOARD_TTL = "5m";

async function clientSite(db: ControlDb, client: AuthorizedClient, siteId: string) {
  const [row] = await db
    .select()
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ConnectError("That site isn't one of this client's.");
  return row;
}

/** The site's backend, or null for a plain website. */
export async function siteBackendOf(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteBackendRow | null> {
  assertAuthorizedClient(client);
  const [row] = await db
    .select()
    .from(siteBackend)
    .where(and(eq(siteBackend.siteId, siteId), eq(siteBackend.locationId, client.location.id)));
  return row ?? null;
}

/**
 * Gives the client's site its own database, once. Owners and admins only. Safe to repeat: a
 * site that already has one gets it back unchanged.
 */
export async function enableSiteBackend(
  deps: SiteBackendDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<SiteBackendRow> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const row = await clientSite(deps.db, client, input.siteId);
  const existing = await siteBackendOf(deps.db, client, row.id);
  if (existing) return existing;

  const name = siteDbName(row.id);
  let made: { dbName: string; hostname: string };
  try {
    made = await deps.provisioner.createDatabase(name);
  } catch (error) {
    // The name comes from the site id, so the database may already exist: made by a request
    // that died before registering it, or by one running right now. Register it either way.
    const found = await deps.provisioner.findDatabase(name);
    if (!found) throw error;
    made = found;
  }
  const { dbName, hostname } = made;
  let created: SiteBackendRow | undefined;
  try {
    [created] = await deps.db
      .insert(siteBackend)
      .values({
        siteId: row.id,
        locationId: client.location.id,
        tursoDbName: dbName,
        tursoDbHostname: hostname,
      })
      .onConflictDoNothing()
      .returning();
  } catch (error) {
    await deps.provisioner.destroy(dbName);
    throw error;
  }
  // A concurrent request registered the same database first: its row stands.
  if (!created) {
    const winner = await siteBackendOf(deps.db, client, row.id);
    if (!winner) throw new ConnectError("The site's database wasn't saved. Try again.");
    return winner;
  }
  await audit(deps.db, ctx, client, "site.backend.enable", { siteId: row.id, dbName });
  return created;
}

/**
 * Deletes the site's database and everything in it, then its registry row. Owners and admins
 * only. It cannot be undone, so callers confirm with the person first.
 */
export async function removeSiteBackend(
  deps: SiteBackendDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<void> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const row = await siteBackendOf(deps.db, client, input.siteId);
  if (!row) return;
  await deps.provisioner.destroy(row.tursoDbName);
  await deps.db.delete(siteBackend).where(eq(siteBackend.siteId, row.siteId));
  await audit(deps.db, ctx, client, "site.backend.remove", {
    siteId: row.siteId,
    dbName: row.tursoDbName,
  });
}

/** What the dashboard shows for one site. */
export interface SiteBackendOverview {
  tables: SiteTable[];
  users: SiteUser[];
}

async function withSiteDb<T>(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  siteId: string,
  read: (db: ReturnType<typeof openSiteDb>) => Promise<T>,
): Promise<T> {
  const row = await siteBackendOf(deps.db, client, siteId);
  if (!row) throw new ConnectError("This site doesn't have a database.");
  // Read-only: the dashboard only looks. Anyone who may work on the client may look.
  const token = await deps.provisioner.mintToken(row.tursoDbName, {
    readOnly: true,
    ttl: DASHBOARD_TTL,
  });
  const db = openSiteDb(deps.provisioner.url(row.tursoDbHostname), token);
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

/** The site's tables and the people signed up on it. */
export function siteBackendOverview(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteBackendOverview> {
  return withSiteDb(deps, client, siteId, async (db) => ({
    tables: await listSiteTables(db),
    users: await listSiteUsers(db),
  }));
}

/** One page of one of the site's tables. */
export function siteBackendRows(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  input: { siteId: string; table: string; limit?: number; offset?: number },
): Promise<SiteRows> {
  return withSiteDb(deps, client, input.siteId, async (db) => {
    try {
      return await readSiteRows(db, input.table, input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The site has no table")) {
        throw new ConnectError(error.message);
      }
      throw error;
    }
  });
}
