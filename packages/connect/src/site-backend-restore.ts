import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import {
  type ControlDb,
  openSiteDb,
  SITE_MIGRATIONS_TABLE,
  siteDbName,
  type TenantProvisioner,
  TursoError,
} from "@locus/db";
import { site, siteBackend, siteBackendRestore } from "@locus/db/control";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  BUSY,
  clientSite,
  projectEnv,
  restoreOf,
  type SiteBackendRow,
  type SiteReleaseDeps,
  siteBackendOf,
  siteProjectId,
  sweepRetired,
  writeSiteDatabaseEnv,
} from "./site-backend.ts";
import { audit } from "./sites.ts";
import { vercel } from "./vercel-api.ts";

// Backups of an app-style site's database are Turso's own: it keeps every database's history
// (24 hours on the free plan, longer on paid ones), so nothing extra is stored or paid for.
// A restore copies the database as it was at a chosen moment into a new database (Turso can't
// restore in place), moves the live site onto that one, and keeps the database it replaced,
// so the restore can be undone. Only the latest replaced database is kept.
//
// One restore or undo runs at a time per site, and publishing waits for it (`busy_until`).
// The live site is moved first: its database settings change and production is deployed again.
// Only once that worked does the registry row move, in the same write as the restore record.
// A database the site stops using is deleted later, not at once: the deployment still live
// keeps using it until the new one is ready.

/** How far back a site's database can be restored: what Turso's free plan keeps. */
export const SITE_RESTORE_WINDOW_MS = 24 * 3_600_000;
/** How long a restore or undo may hold the site before another can start. */
const LOCK_MS = 10 * 60_000;
/** How long a database the site stopped using is kept for the deployment still using it. */
const RETIRE_AFTER_MS = 2 * 3_600_000;

export type SiteRestoreDeps = SiteReleaseDeps & {
  now?: () => number;
  /** How far back Turso keeps history on Otaku's plan. */
  restoreWindowMs?: number;
};

export interface SiteRestoreState {
  /** The earliest moment the database can be restored to. */
  earliest: Date;
  /** The last restore, while the database it replaced is kept (it can be undone). */
  undo: { restoredTo: Date; restoredAt: Date } | null;
}

type Target = { tursoDbName: string; tursoDbHostname: string };

/** What the Database page offers: how far back a restore can go, and whether one can be undone. */
export async function siteRestoreState(
  deps: Pick<SiteRestoreDeps, "db" | "now" | "restoreWindowMs">,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteRestoreState | null> {
  const backend = await siteBackendOf(deps.db, client, siteId);
  if (!backend) return null;
  const restore = await restoreOf(deps.db, backend.siteId);
  const now = deps.now?.() ?? Date.now();
  // A restored database has no history from before it was made.
  const since = (restore?.currentSince ?? backend.createdAt).getTime();
  return {
    earliest: new Date(Math.max(now - (deps.restoreWindowMs ?? SITE_RESTORE_WINDOW_MS), since)),
    undo:
      restore?.keptDbName && restore.restoredTo && restore.restoredAt
        ? { restoredTo: restore.restoredTo, restoredAt: restore.restoredAt }
        : null,
  };
}

/** Takes the site for one restore or undo, or refuses while another (or a publish) has it. */
async function claim(db: ControlDb, backend: SiteBackendRow, now: number) {
  await db
    .insert(siteBackendRestore)
    .values({
      siteId: backend.siteId,
      locationId: backend.locationId,
      currentSince: backend.createdAt,
    })
    .onConflictDoNothing();
  const [claimed] = await db
    .update(siteBackendRestore)
    .set({ busyUntil: new Date(now + LOCK_MS) })
    .where(
      and(
        eq(siteBackendRestore.siteId, backend.siteId),
        or(isNull(siteBackendRestore.busyUntil), lt(siteBackendRestore.busyUntil, new Date(now))),
      ),
    )
    .returning();
  if (!claimed) throw new ConnectError(BUSY);
  // Read again under the claim: another restore may have moved the site just before.
  const [current] = await db
    .select()
    .from(siteBackend)
    .where(eq(siteBackend.siteId, backend.siteId));
  if (!current) {
    await release(db, backend.siteId);
    throw new ConnectError("This site doesn't have a database.");
  }
  return { restore: claimed, backend: current };
}

async function release(db: ControlDb, siteId: string) {
  await db
    .update(siteBackendRestore)
    .set({ busyUntil: null })
    .where(eq(siteBackendRestore.siteId, siteId));
}

/** The migrations a database has applied, by name. */
async function appliedMigrations(provisioner: TenantProvisioner, target: Target) {
  const token = await provisioner.mintToken(target.tursoDbName, { readOnly: true, ttl: "5m" });
  const db = openSiteDb(provisioner.url(target.tursoDbHostname), token);
  try {
    const rows = await db.execute(`select name from ${SITE_MIGRATIONS_TABLE}`);
    return new Set(rows.rows.map((row) => String(row.name)));
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return new Set<string>();
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Moves the live site onto `target`: its database address and token are changed in place,
 * then production is deployed again from its repository. Does nothing for a site without a
 * project. Throws when either step fails, after putting the settings back to `fallback`.
 */
async function moveLiveSite(
  deps: SiteRestoreDeps & { provisioner: TenantProvisioner },
  client: AuthorizedClient,
  siteId: string,
  target: Target,
  fallback: Target,
): Promise<boolean> {
  const projectId = await siteProjectId(deps.db, client, siteId);
  if (!projectId) return false;
  const env = await projectEnv(deps, client, projectId);
  try {
    await writeSiteDatabaseEnv(deps, env, projectId, deps.provisioner, target);
    await deployProduction(deps, env, client, siteId, projectId);
    return true;
  } catch (error) {
    // The live deployment never changed; its settings go back to the database it uses.
    try {
      await writeSiteDatabaseEnv(
        deps,
        await projectEnv(deps, client, projectId),
        projectId,
        deps.provisioner,
        fallback,
      );
    } catch {
      // The next publish rewrites them from the registry row.
      await deps.db
        .update(siteBackendRestore)
        .set({ envStale: true })
        .where(eq(siteBackendRestore.siteId, siteId));
    }
    throw error;
  }
}

async function deployProduction(
  deps: SiteRestoreDeps,
  env: Awaited<ReturnType<typeof projectEnv>>,
  client: AuthorizedClient,
  siteId: string,
  projectId: string,
) {
  const [row] = await deps.db
    .select({ repoFullName: site.repoFullName })
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  const [owner, repo] = (row?.repoFullName ?? "").split("/");
  if (!owner || !repo) throw new ConnectError("The site's project has no repository to deploy.");
  const project = await vercel<{ name?: string; link?: { productionBranch?: string } }>(
    env.deps,
    env.grant,
    "GET",
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );
  const deployed = project.ok
    ? await vercel(env.deps, env.grant, "POST", "/v13/deployments", {
        body: {
          name: project.body.name ?? repo,
          project: projectId,
          target: "production",
          gitSource: {
            type: "github",
            org: owner,
            repo,
            ref: project.body.link?.productionBranch ?? "main",
          },
        },
      })
    : project;
  if (!deployed.ok) {
    throw new ConnectError("Vercel didn't deploy the site again, so nothing changed. Try again.");
  }
}

function needsProvisioner(deps: SiteRestoreDeps) {
  if (!deps.provisioner) {
    throw new ConnectError("This site's database isn't set up on this deployment yet.");
  }
  return deps.provisioner;
}

/**
 * Restores the site's database to how it was at `to`, for owners and admins: everything
 * written after that moment is gone from the live site, though the database it had until now
 * is kept, so `undoSiteBackendRestore` brings it back. Callers confirm with the person first.
 * Returns whether the live site was deployed again (a site that isn't published yet gets the
 * restored database with its first publish).
 */
export async function restoreSiteBackend(
  deps: SiteRestoreDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string; to: Date },
): Promise<{ redeployed: boolean }> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  await clientSite(deps.db, client, input.siteId);
  const found = await siteBackendOf(deps.db, client, input.siteId);
  if (!found) throw new ConnectError("This site doesn't have a database.");
  const provisioner = needsProvisioner(deps);
  const now = deps.now?.() ?? Date.now();
  const to = input.to.getTime();
  const state = await siteRestoreState(deps, client, found.siteId);
  if (!Number.isFinite(to) || !state || to < state.earliest.getTime() || to > now) {
    throw new ConnectError("Choose a moment within the times shown.");
  }

  const { restore, backend } = await claim(deps.db, found, now);
  try {
    if (to < (restore.currentSince ?? backend.createdAt).getTime()) {
      throw new ConnectError("Choose a moment within the times shown.");
    }
    const made = await provisioner
      .createDatabase(`${siteDbName(backend.siteId)}-r${now.toString(36)}`, {
        fork: { from: backend.tursoDbName, at: input.to },
      })
      .catch((error) => {
        if (error instanceof TursoError) {
          throw new ConnectError(
            "Locus couldn't restore the site's database to that moment. Try again.",
          );
        }
        throw error;
      });
    const copy = { tursoDbName: made.dbName, tursoDbHostname: made.hostname };
    let redeployed: boolean;
    try {
      // The live site's code expects the tables its published versions added.
      const before = await appliedMigrations(provisioner, copy);
      const missing = [...(await appliedMigrations(provisioner, backend))].filter(
        (name) => !before.has(name),
      );
      if (missing.length > 0) {
        throw new ConnectError(
          `At that moment the database didn't have changes the live site needs (${missing.join(", ")}). Choose a later time.`,
        );
      }
      redeployed = await moveLiveSite(
        { ...deps, provisioner },
        client,
        backend.siteId,
        copy,
        backend,
      );
    } catch (error) {
      await provisioner.destroy(made.dbName);
      throw error;
    }

    // The database replaced before this one is no longer kept for undo; the one just replaced
    // is, and nothing is deleted while a deployment may still use it.
    const retired = [...restore.retired];
    if (restore.keptDbName) {
      retired.push({ dbName: restore.keptDbName, deleteAfter: now + RETIRE_AFTER_MS });
    }
    await deps.db.batch([
      deps.db
        .update(siteBackend)
        .set({ tursoDbName: copy.tursoDbName, tursoDbHostname: copy.tursoDbHostname })
        .where(eq(siteBackend.siteId, backend.siteId)),
      deps.db
        .update(siteBackendRestore)
        .set({
          currentSince: new Date(now),
          keptDbName: backend.tursoDbName,
          keptDbHostname: backend.tursoDbHostname,
          keptSince: restore.currentSince ?? backend.createdAt,
          restoredTo: input.to,
          restoredAt: new Date(now),
          retired,
        })
        .where(eq(siteBackendRestore.siteId, backend.siteId)),
    ]);
    await audit(deps.db, ctx, client, "site.backend.restore", {
      siteId: backend.siteId,
      restoredTo: input.to.toISOString(),
      from: backend.tursoDbName,
      to: copy.tursoDbName,
    });
    await sweepRetired({ db: deps.db, provisioner }, { ...backend, ...copy }, now);
    return { redeployed };
  } finally {
    await release(deps.db, backend.siteId);
  }
}

/**
 * Undoes the site's last restore, for owners and admins: the live site goes back to the
 * database it had before, and the restored one, with anything written to it since, is deleted
 * once the live site no longer uses it. Callers confirm with the person first.
 */
export async function undoSiteBackendRestore(
  deps: SiteRestoreDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<{ redeployed: boolean }> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const found = await siteBackendOf(deps.db, client, input.siteId);
  if (!found) throw new ConnectError("There's no restore to undo.");
  const provisioner = needsProvisioner(deps);
  const now = deps.now?.() ?? Date.now();
  const { restore, backend } = await claim(deps.db, found, now);
  try {
    if (
      !restore.keptDbName ||
      !restore.keptDbHostname ||
      restore.keptDbName === backend.tursoDbName
    ) {
      throw new ConnectError("There's no restore to undo.");
    }
    const kept = { tursoDbName: restore.keptDbName, tursoDbHostname: restore.keptDbHostname };
    const redeployed = await moveLiveSite(
      { ...deps, provisioner },
      client,
      backend.siteId,
      kept,
      backend,
    );
    await deps.db.batch([
      deps.db.update(siteBackend).set(kept).where(eq(siteBackend.siteId, backend.siteId)),
      deps.db
        .update(siteBackendRestore)
        .set({
          currentSince: restore.keptSince ?? backend.createdAt,
          keptDbName: null,
          keptDbHostname: null,
          keptSince: null,
          restoredTo: null,
          restoredAt: null,
          retired: [
            ...restore.retired,
            { dbName: backend.tursoDbName, deleteAfter: now + RETIRE_AFTER_MS },
          ],
        })
        .where(eq(siteBackendRestore.siteId, backend.siteId)),
    ]);
    await audit(deps.db, ctx, client, "site.backend.restore.undo", {
      siteId: backend.siteId,
      from: backend.tursoDbName,
      to: kept.tursoDbName,
    });
    await sweepRetired({ db: deps.db, provisioner }, { ...backend, ...kept }, now);
    return { redeployed };
  } finally {
    await release(deps.db, backend.siteId);
  }
}
