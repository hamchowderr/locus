import { randomBytes, randomUUID } from "node:crypto";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import {
  applySiteMigrations,
  type ControlDb,
  listSiteTables,
  listSiteUsers,
  openSiteDb,
  readSiteRows,
  SITE_DATABASE_ENV,
  SiteMigrationError,
  type SiteRows,
  type SiteTable,
  type SiteUser,
  siteDbName,
  siteMigrationsIn,
  type TenantProvisioner,
  TursoError,
} from "@locus/db";
import { auditLog, site, siteBackend, siteBackendRestore } from "@locus/db/control";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import { audit } from "./sites.ts";
import { hostGrant, refused, type VercelCallDeps, vercel } from "./vercel-api.ts";

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

export async function clientSite(db: ControlDb, client: AuthorizedClient, siteId: string) {
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

/** Which of the client's sites have their own database. */
export async function sitesWithBackend(
  db: ControlDb,
  client: AuthorizedClient,
): Promise<Set<string>> {
  assertAuthorizedClient(client);
  const rows = await db
    .select({ siteId: siteBackend.siteId })
    .from(siteBackend)
    .where(eq(siteBackend.locationId, client.location.id));
  return new Set(rows.map((row) => row.siteId));
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
  const { row, created } = await provisionSiteBackend(deps, client, input.siteId);
  if (created) {
    await audit(deps.db, ctx, client, "site.backend.enable", {
      siteId: row.siteId,
      dbName: row.tursoDbName,
    });
  }
  return row;
}

/** The site's database, made (and registered) if it has none yet. */
async function provisionSiteBackend(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<{ row: SiteBackendRow; created: boolean }> {
  const row = await clientSite(deps.db, client, siteId);
  const existing = await siteBackendOf(deps.db, client, row.id);
  if (existing) return { row: existing, created: false };

  const name = siteDbName(row.id);
  let made: { dbName: string; hostname: string };
  try {
    try {
      made = await deps.provisioner.createDatabase(name);
    } catch (error) {
      // The name comes from the site id, so the database may already exist: made by a request
      // that died before registering it, or by one running right now. Register it either way.
      const found = await deps.provisioner.findDatabase(name);
      if (!found) throw error;
      made = found;
    }
  } catch (error) {
    if (error instanceof TursoError) throw new ConnectError(NOT_MADE);
    throw error;
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
    return { row: winner, created: false };
  }
  return { row: created, created: true };
}

/**
 * Deletes the site's database and everything in it, then its registry row. Owners and admins
 * only. It cannot be undone, so callers confirm with the person first. The site's project
 * loses its database settings first: a database made again later under the same name gets
 * new ones on the next publish instead of the dead token. Files members uploaded stay in the
 * client's Media Library (the agency's own), in the site's "Site uploads" folder.
 */
export async function removeSiteBackend(
  deps: SiteBackendDeps & Partial<Pick<VercelCallDeps, "secrets" | "http">>,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<void> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const found = await siteBackendOf(deps.db, client, input.siteId);
  if (!found) return;
  // Nothing else may change the site's database meanwhile; the hold goes with its record.
  const { restore, backend: row, until } = await holdSite(deps.db, found, Date.now());
  try {
    const projectId = await siteProjectId(deps.db, client, row.siteId);
    if (projectId) {
      if (!deps.secrets) throw new ConnectError("Vercel isn't set up on this deployment yet.");
      const env = await projectEnv({ ...deps, secrets: deps.secrets }, client, projectId);
      for (const variable of env.ours) {
        const gone = await vercel(
          env.deps,
          env.grant,
          "DELETE",
          `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variable.id)}`,
        );
        if (!gone.ok && gone.status !== 404) {
          throw refused(gone, "Vercel didn't remove the site's database settings. Try again.");
        }
      }
    }
    // The database a restore replaced, kept for undo, goes with it.
    for (const name of [restore.keptDbName, ...restore.retired.map((r) => r.dbName)]) {
      if (name && name !== row.tursoDbName) await deps.provisioner.destroy(name);
    }
  } catch (error) {
    await letGo(deps.db, row.siteId, until);
    throw error;
  }
  await deps.db.delete(siteBackendRestore).where(eq(siteBackendRestore.siteId, row.siteId));
  await deps.provisioner.destroy(row.tursoDbName);
  await deps.db.delete(siteBackend).where(eq(siteBackend.siteId, row.siteId));
  await audit(deps.db, ctx, client, "site.backend.remove", {
    siteId: row.siteId,
    dbName: row.tursoDbName,
  });
}

/** What the dashboard shows for one site, with one page of a table when one was asked for. */
export interface SiteBackendOverview {
  tables: SiteTable[];
  users: SiteUser[];
  rows?: SiteRows;
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
  // Big integers (ids, cents, hashes) come back whole instead of failing the read.
  const db = openSiteDb(deps.provisioner.url(row.tursoDbHostname), token, { intMode: "bigint" });
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

/**
 * Tables that hold login secrets: Better Auth's password hashes, session tokens and reset
 * codes, and the secrets of its plugins. The dashboard shows how many rows they have, never
 * the rows.
 */
export const LOGIN_SECRET_TABLES: ReadonlySet<string> = new Set([
  "account",
  "session",
  "verification",
  "twoFactor",
  "two_factor",
  "passkey",
  "apikey",
  "api_key",
  "jwks",
  "oauthApplication",
  "oauth_application",
  "oauthAccessToken",
  "oauth_access_token",
]);

/** Columns whose values stay hidden in any table, whatever the agent named the table. */
const SECRET_COLUMN = /password|secret|token|private_?key|backup_?codes|hash|api_?key/i;

const HIDDEN = "(hidden)";

async function readRows(
  db: ReturnType<typeof openSiteDb>,
  input: { table: string; limit?: number; offset?: number },
): Promise<SiteRows> {
  if (LOGIN_SECRET_TABLES.has(input.table)) {
    throw new ConnectError("That table holds login secrets, so Locus doesn't show its rows.");
  }
  let page: SiteRows;
  try {
    page = await readSiteRows(db, input.table, input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The site has no table")) {
      throw new ConnectError(error.message);
    }
    throw error;
  }
  const secret = page.columns.filter((column) => SECRET_COLUMN.test(column));
  if (secret.length === 0) return page;
  return {
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      ...Object.fromEntries(secret.map((column) => [column, row[column] == null ? null : HIDDEN])),
    })),
  };
}

/** The site's tables and the people signed up on it, and one page of `table` if given. */
export function siteBackendOverview(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  siteId: string,
  page?: { table: string; limit?: number; offset?: number },
): Promise<SiteBackendOverview> {
  return withSiteDb(deps, client, siteId, async (db) => ({
    tables: await listSiteTables(db),
    users: await listSiteUsers(db),
    ...(page ? { rows: await readRows(db, page) } : {}),
  }));
}

/** One page of one of the site's tables. Secret tables are refused, secret columns hidden. */
export function siteBackendRows(
  deps: SiteBackendDeps,
  client: AuthorizedClient,
  input: { siteId: string; table: string; limit?: number; offset?: number },
): Promise<SiteRows> {
  return withSiteDb(deps, client, input.siteId, (db) => readRows(db, input));
}

/** What publishing an app-style site needs: its database, and the agency's Vercel team. */
export interface SiteReleaseDeps extends VercelCallDeps {
  /** Absent where Locus has no database host set up; a site with a database is then refused. */
  provisioner?: TenantProvisioner;
  /**
   * The site's files key (`siteFilesKey`), set on its host so its routes can reach its files.
   * Absent where Locus has no file storage set up: the site then gets no key and can't keep
   * files until a later publish.
   */
  siteFilesKey?: (siteId: string) => string;
}

/** How long the token that applies a publish's database changes lives. */
const MIGRATE_TTL = "10m";

const NO_PROVISIONER = "This site's database isn't set up on this deployment yet.";
export const BUSY =
  "The site's database is being changed right now (a restore or a publish). Try again in a minute.";
const NOT_MADE = "Locus couldn't make the site's database. Try again.";
const REMOVED =
  "This site's database was removed, so Locus won't make a new one on its own. Take the " +
  "db/migrations files out to publish it as a plain website.";

/**
 * Applies the version's new database changes (its `db/migrations/` files) to the site's own
 * database, before the version is sent to GitHub: a change that fails stops the publish, so
 * the live site never runs code that expects tables its database lacks. The first version
 * with migrations gives the site its database (the agent made it an app-style site in the
 * chat). Does nothing for a plain website. Anyone who may work on the client may publish; the
 * token is minted after that check, names only the site's database and lives ten minutes.
 */
export async function migrateSiteBackend(
  deps: SiteReleaseDeps,
  client: AuthorizedClient,
  input: { siteId: string; files: { path: string; content: string | Uint8Array }[] },
): Promise<{ applied: string[] } | null> {
  assertAuthorizedClient(client);
  let migrations: ReturnType<typeof siteMigrationsIn>;
  try {
    migrations = siteMigrationsIn(input.files);
  } catch (error) {
    throw migrationRefusal(error);
  }
  const found = await siteBackendOf(deps.db, client, input.siteId);
  if (!found && migrations.length === 0) return null;
  if (!deps.provisioner) throw new ConnectError(NO_PROVISIONER);
  const release = { ...deps, provisioner: deps.provisioner };
  if (!found) return applyMigrations(release, client, input.siteId, null, migrations);
  // A restore swaps the site's database: the site is held while its changes apply, so a
  // restore can't move it part way, and a publish waits for a restore to finish.
  const held = await holdSite(deps.db, found, Date.now());
  try {
    await sweepRetired(
      { ...deps, provisioner: deps.provisioner },
      client,
      held.backend,
      Date.now(),
    );
    return await applyMigrations(release, client, input.siteId, held.backend, migrations);
  } finally {
    await letGo(deps.db, found.siteId, held.until);
  }
}

async function applyMigrations(
  deps: SiteReleaseDeps & { provisioner: TenantProvisioner },
  client: AuthorizedClient,
  siteId: string,
  existing: SiteBackendRow | null,
  migrations: ReturnType<typeof siteMigrationsIn>,
): Promise<{ applied: string[] }> {
  let row = existing;
  if (!row) {
    // Removing a site's database is an owner's choice; a later save doesn't quietly undo it.
    if (await backendRemoved(deps.db, client, siteId)) throw new ConnectError(REMOVED);
    const provisioned = await provisionSiteBackend(
      { db: deps.db, provisioner: deps.provisioner },
      client,
      siteId,
    );
    row = provisioned.row;
    if (provisioned.created) {
      await deps.db.insert(auditLog).values({
        id: randomUUID(),
        organizationId: client.location.organizationId,
        // Made by publishing the version that first had migrations; the member who published
        // it is in the detail.
        actorUserId: null,
        locationId: client.location.id,
        action: "site.backend.enable",
        detail: {
          siteId: row.siteId,
          dbName: row.tursoDbName,
          by: "publish",
          memberId: client.memberId,
        },
      });
    }
  }
  const token = await deps.provisioner.mintToken(row.tursoDbName, { ttl: MIGRATE_TTL });
  const db = openSiteDb(deps.provisioner.url(row.tursoDbHostname), token);
  try {
    return await applySiteMigrations(db, migrations);
  } catch (error) {
    throw migrationRefusal(error);
  } finally {
    db.close();
  }
}

/** Whether an owner or admin removed the site's database (and no one turned it on again). */
async function backendRemoved(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.locationId, client.location.id),
        eq(auditLog.action, "site.backend.remove"),
        sql`json_extract(${auditLog.detail}, '$.siteId') = ${siteId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** A migration's own fault, for the person and the agent; anything else as it was. */
function migrationRefusal(error: unknown): unknown {
  if (!(error instanceof SiteMigrationError)) return error;
  // A failed migration rolled back and never ran, so the fix is in that file itself; one that
  // ran stays frozen, and a misnamed file only needs renaming.
  const fix = / failed: /.test(error.message)
    ? " That file didn't run, so fix it in place."
    : / was changed after it ran\./.test(error.message)
      ? ""
      : " Rename the file to fix it.";
  return new ConnectError(
    `The site's database change didn't apply: ${error.message.replace(/\.?$/, ".")}${fix} Keep changes additive so the live site's current code still works.`,
  );
}

type EnvVar = { id?: string; key?: string; target?: string[] | string; gitBranch?: string | null };

const OUR_KEYS = new Set<string>(Object.values(SITE_DATABASE_ENV));

export async function siteProjectId(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ hostProjectId: site.hostProjectId })
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  return row?.hostProjectId ?? null;
}

/** The project's variables, and which of them are the site database's. */
export async function projectEnv(
  deps: VercelCallDeps,
  client: AuthorizedClient,
  projectId: string,
) {
  const grant = await hostGrant(deps, client.location.organizationId);
  const path = `/v10/projects/${encodeURIComponent(projectId)}/env`;
  const listed = await vercel<{ envs?: EnvVar[] }>(deps, grant, "GET", path);
  if (!listed.ok) throw refused(listed, "Vercel didn't show the site's settings. Try again.");
  const ours = (listed.body.envs ?? []).filter(
    (env): env is EnvVar & { id: string; key: string } =>
      !!env.id && !!env.key && OUR_KEYS.has(env.key),
  );
  return { deps, grant, path, ours };
}

/** A variable the live site reads: one for production on every branch. */
export const servesProduction = (env: EnvVar) =>
  !env.gitBranch && [env.target ?? []].flat().includes("production");

/**
 * Puts the site's database address, its token and the site's own login secret on its Vercel
 * project's production environment, as sensitive variables, once each: one already there is
 * left alone. Previews get none, so a preview build never touches the live site's members.
 * Does nothing for a plain website or a site without a project yet. Locus keeps none of them;
 * the token names only the site's database and is revoked by rotating that database's tokens,
 * which leaves every other database's untouched (checked against Turso, 2026-10-20).
 */
export async function ensureSiteBackendEnv(
  deps: SiteReleaseDeps,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<string[]> {
  const row = await siteBackendOf(deps.db, client, input.siteId);
  if (!row) return [];
  const projectId = await siteProjectId(deps.db, client, row.siteId);
  if (!projectId) return [];
  if (!deps.provisioner) throw new ConnectError(NO_PROVISIONER);
  // Held so a restore or key reset can't change the database or its key while this writes.
  const { backend, until } = await holdSite(deps.db, row, Date.now());
  try {
    return await writeMissingEnv(deps, client, backend, projectId, deps.provisioner);
  } finally {
    await letGo(deps.db, row.siteId, until);
  }
}

async function writeMissingEnv(
  deps: SiteReleaseDeps,
  client: AuthorizedClient,
  row: SiteBackendRow,
  projectId: string,
  provisioner: TenantProvisioner,
): Promise<string[]> {
  let env = await projectEnv(deps, client, projectId);
  const restore = await restoreOf(deps.db, row.siteId);
  const rewritten: string[] = [];
  if (restore?.envStale) {
    // A restore that failed part way may have left them naming another database.
    await writeSiteDatabaseEnv(deps, env, projectId, provisioner, row);
    // Deployments made until now may have used any of the databases it stopped using, so
    // those count from here.
    const fixedAt = Date.now();
    await deps.db
      .update(siteBackendRestore)
      .set({
        envStale: false,
        retired: restore.retired.map((r) => ({ ...r, retiredAt: Math.max(r.retiredAt, fixedAt) })),
      })
      .where(eq(siteBackendRestore.siteId, row.siteId));
    rewritten.push(SITE_DATABASE_ENV.url, SITE_DATABASE_ENV.token);
    env = await projectEnv(deps, client, projectId);
  }
  const present = new Set(env.ours.filter(servesProduction).map((v) => v.key));
  const values: Record<string, () => Promise<string>> = {
    [SITE_DATABASE_ENV.url]: async () => provisioner.url(row.tursoDbHostname),
    [SITE_DATABASE_ENV.token]: () => provisioner.mintToken(row.tursoDbName, { ttl: "never" }),
    [SITE_DATABASE_ENV.authSecret]: async () => randomBytes(32).toString("base64url"),
  };
  const filesKey = deps.siteFilesKey;
  if (filesKey) values[SITE_DATABASE_ENV.filesKey] = async () => filesKey(row.siteId);
  const missing = Object.keys(values).filter((key) => !present.has(key));
  if (missing.length === 0) return rewritten;
  const body = [];
  for (const key of missing) {
    body.push({
      key,
      value: await (values[key] as () => Promise<string>)(),
      type: "sensitive",
      target: ["production"],
    });
  }
  const added = await vercel<{ failed?: unknown[] }>(deps, env.grant, "POST", env.path, {
    body,
  });
  // Vercel answers a batch with 2xx and lists the ones it refused (a concurrent publish that
  // added the same key first, say); the next publish fills in whatever is still missing.
  if (!added.ok || (added.body.failed?.length ?? 0) > 0) {
    throw refused(added, "Vercel didn't take the site's database settings. Try again.");
  }
  return [...rewritten, ...missing];
}

/** The site's restore record, if it was ever restored. */
export async function restoreOf(db: ControlDb, siteId: string) {
  const [row] = await db
    .select()
    .from(siteBackendRestore)
    .where(eq(siteBackendRestore.siteId, siteId));
  return row ?? null;
}

/** How long a restore, undo, publish or removal may hold the site before another can start. */
const HOLD_MS = 10 * 60_000;

/**
 * Takes the site for one change to its database (a restore, an undo, a publish's migrations,
 * its removal), or refuses while another has it. Returns the site's records read under the
 * hold, and the hold's own expiry, which `letGo` needs: a hold that ran out and was taken by
 * someone else is theirs.
 */
export async function holdSite(db: ControlDb, backend: SiteBackendRow, now: number) {
  await db
    .insert(siteBackendRestore)
    .values({
      siteId: backend.siteId,
      locationId: backend.locationId,
      currentSince: backend.createdAt,
    })
    .onConflictDoNothing();
  const until = new Date(now + HOLD_MS);
  const [restore] = await db
    .update(siteBackendRestore)
    .set({ busyUntil: until })
    .where(
      and(
        eq(siteBackendRestore.siteId, backend.siteId),
        or(isNull(siteBackendRestore.busyUntil), lt(siteBackendRestore.busyUntil, new Date(now))),
      ),
    )
    .returning();
  if (!restore) throw new ConnectError(BUSY);
  // Read again under the hold: a restore may have moved the site just before.
  const [current] = await db
    .select()
    .from(siteBackend)
    .where(eq(siteBackend.siteId, backend.siteId));
  if (!current) {
    await letGo(db, backend.siteId, until);
    throw new ConnectError("This site doesn't have a database.");
  }
  return { restore, backend: current, until };
}

/** Ends a hold, if it is still this one. */
export async function letGo(db: ControlDb, siteId: string, until: Date) {
  await db
    .update(siteBackendRestore)
    .set({ busyUntil: null })
    .where(and(eq(siteBackendRestore.siteId, siteId), eq(siteBackendRestore.busyUntil, until)));
}

/** When the site's newest ready production deployment was made, or null when unknown. */
async function liveSince(
  deps: VercelCallDeps,
  client: AuthorizedClient,
  projectId: string,
): Promise<number | null> {
  try {
    const grant = await hostGrant(deps, client.location.organizationId);
    const listed = await vercel<{ deployments?: { createdAt?: number }[] }>(
      deps,
      grant,
      "GET",
      "/v6/deployments",
      { query: { projectId, target: "production", state: "READY", limit: "1" } },
    );
    const createdAt = listed.ok ? listed.body.deployments?.[0]?.createdAt : undefined;
    return typeof createdAt === "number" ? createdAt : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the databases the site stopped using, once no deployment can still be using them:
 * their time has passed and production has been deployed (and is ready) since. A deploy that
 * was accepted but failed to build leaves the old deployment live on its old database, which
 * is then kept. Never the one the site uses now, nor the one kept for undo.
 */
export async function sweepRetired(
  deps: SiteBackendDeps & Partial<Pick<VercelCallDeps, "secrets" | "http">>,
  client: AuthorizedClient,
  backend: SiteBackendRow,
  now: number,
): Promise<void> {
  const restore = await restoreOf(deps.db, backend.siteId);
  // While the live site's settings may name any of them, none is deleted.
  if (!restore || restore.retired.length === 0 || restore.envStale) return;
  const keep = new Set([backend.tursoDbName, restore.keptDbName]);
  let due = restore.retired.filter((r) => r.deleteAfter <= now && !keep.has(r.dbName));
  if (due.length === 0) return;
  const projectId = await siteProjectId(deps.db, client, backend.siteId);
  if (projectId) {
    const since = deps.secrets
      ? await liveSince({ ...deps, secrets: deps.secrets }, client, projectId)
      : null;
    due = since === null ? [] : due.filter((r) => r.retiredAt < since);
    if (due.length === 0) return;
  }
  for (const r of due) await deps.provisioner.destroy(r.dbName);
  const gone = new Set(due.map((r) => r.dbName));
  // Written as "whatever is there now, minus what was deleted", so a concurrent change stays.
  const latest = await restoreOf(deps.db, backend.siteId);
  if (!latest) return;
  await deps.db
    .update(siteBackendRestore)
    .set({ retired: latest.retired.filter((r) => !gone.has(r.dbName)) })
    .where(eq(siteBackendRestore.siteId, backend.siteId));
}

/**
 * Sets the live site's database address and token to `target`'s, changing the existing values
 * in place (so there is never a moment without them) and adding any that are missing.
 */
export async function writeSiteDatabaseEnv(
  deps: VercelCallDeps,
  env: Awaited<ReturnType<typeof projectEnv>>,
  projectId: string,
  provisioner: TenantProvisioner,
  target: { tursoDbName: string; tursoDbHostname: string },
): Promise<void> {
  const values: Record<string, string> = {
    [SITE_DATABASE_ENV.url]: provisioner.url(target.tursoDbHostname),
    [SITE_DATABASE_ENV.token]: await provisioner.mintToken(target.tursoDbName, { ttl: "never" }),
  };
  const missing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const existing = env.ours.find((v) => v.key === key && servesProduction(v));
    if (!existing) {
      missing.push(key);
      continue;
    }
    const edited = await vercel(
      deps,
      env.grant,
      "PATCH",
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(existing.id)}`,
      { body: { value, type: "sensitive", target: ["production"] } },
    );
    if (!edited.ok) {
      throw refused(edited, "Vercel didn't change the site's database settings. Try again.");
    }
  }
  if (missing.length === 0) return;
  const added = await vercel<{ failed?: unknown[] }>(deps, env.grant, "POST", env.path, {
    body: missing.map((key) => ({
      key,
      value: values[key],
      type: "sensitive",
      target: ["production"],
    })),
  });
  if (!added.ok || (added.body.failed?.length ?? 0) > 0) {
    throw refused(added, "Vercel didn't take the site's database settings. Try again.");
  }
}
