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
import { and, eq, sql } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  clientSite,
  holdSite,
  letGo,
  projectEnv,
  restoreOf,
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
// One restore, undo, publish or removal changes a site's database at a time (`holdSite`).
// The live site is moved first: its database settings change and production is deployed again.
// Only once that worked does the registry row move, in the same write as the restore record,
// and only while the hold is still this one. A database the site stops using is deleted later,
// not at once: the deployment still live keeps using it until a newer one is ready.

/** How far back a site's database can be restored: what Turso's free plan keeps. */
export const SITE_RESTORE_WINDOW_MS = 24 * 3_600_000;
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
): Promise<{ redeployed: boolean; switchedAt: number }> {
  const projectId = await siteProjectId(deps.db, client, siteId);
  if (!projectId) return { redeployed: false, switchedAt: deps.now?.() ?? Date.now() };
  const env = await projectEnv(deps, client, projectId);
  try {
    await writeSiteDatabaseEnv(deps, env, projectId, deps.provisioner, target);
    // Any deployment made from here on, this one included, uses `target`.
    const switchedAt = deps.now?.() ?? Date.now();
    await deployProduction(deps, env, client, siteId, projectId);
    return { redeployed: true, switchedAt };
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
      await markStale(deps.db, siteId);
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

/** The migrations `from` has that `to` lacks: the live code needs them. */
async function migrationsMissing(provisioner: TenantProvisioner, from: Target, to: Target) {
  const has = await appliedMigrations(provisioner, to);
  return [...(await appliedMigrations(provisioner, from))].filter((name) => !has.has(name));
}

/** Writes the swap, unless the hold ran out and someone else took the site meanwhile. */
async function commitSwap(
  db: ControlDb,
  siteId: string,
  until: Date,
  target: Target,
  record: Partial<typeof siteBackendRestore.$inferInsert>,
) {
  const held = and(eq(siteBackendRestore.siteId, siteId), eq(siteBackendRestore.busyUntil, until));
  const [recorded] = await db.batch([
    db
      .update(siteBackendRestore)
      .set(record)
      .where(held)
      .returning({ siteId: siteBackendRestore.siteId }),
    db
      .update(siteBackend)
      .set(target)
      .where(
        and(
          eq(siteBackend.siteId, siteId),
          sql`exists (select 1 from ${siteBackendRestore} where ${held})`,
        ),
      ),
  ]);
  if (recorded.length === 0) {
    throw new ConnectError(
      "The restore took too long and was stopped. Check the site, then try again.",
    );
  }
}

/** Keeps a database the live site may be using until a newer deployment is ready. */
async function retire(db: ControlDb, siteId: string, dbName: string, now: number) {
  // Appended in one statement: whoever holds the site may be changing the list too.
  const entry = JSON.stringify({ dbName, retiredAt: now, deleteAfter: now + RETIRE_AFTER_MS });
  await db
    .update(siteBackendRestore)
    .set({ retired: sql`json_insert(${siteBackendRestore.retired}, '$[#]', json(${entry}))` })
    .where(eq(siteBackendRestore.siteId, siteId));
}

/** The live site's settings may not name its registered database: the next publish rewrites them. */
async function markStale(db: ControlDb, siteId: string) {
  await db
    .update(siteBackendRestore)
    .set({ envStale: true })
    .where(eq(siteBackendRestore.siteId, siteId));
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

  const { restore, backend, until } = await holdSite(deps.db, found, now);
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
    let moved: { redeployed: boolean; switchedAt: number };
    try {
      // The live site's code expects the tables its published versions added.
      const missing = await migrationsMissing(provisioner, backend, copy);
      if (missing.length > 0) {
        throw new ConnectError(
          `At that moment the database didn't have changes the live site needs (${missing.join(", ")}). Choose a later time.`,
        );
      }
      moved = await moveLiveSite({ ...deps, provisioner }, client, backend.siteId, copy, backend);
    } catch (error) {
      // Settings that couldn't be put back may name the copy: it stays until they're fixed.
      if ((await restoreOf(deps.db, backend.siteId))?.envStale) {
        await retire(deps.db, backend.siteId, made.dbName, deps.now?.() ?? Date.now());
      } else {
        await provisioner.destroy(made.dbName);
      }
      throw error;
    }

    // The database replaced before this one is no longer kept for undo; the one just replaced
    // is, and nothing is deleted while a deployment may still use it.
    const { redeployed, switchedAt } = moved;
    const retired = [...restore.retired];
    if (restore.keptDbName) {
      retired.push({
        dbName: restore.keptDbName,
        retiredAt: switchedAt,
        deleteAfter: switchedAt + RETIRE_AFTER_MS,
      });
    }
    try {
      await commitSwap(deps.db, backend.siteId, until, copy, {
        currentSince: new Date(now),
        keptDbName: backend.tursoDbName,
        keptDbHostname: backend.tursoDbHostname,
        keptSince: restore.currentSince ?? backend.createdAt,
        restoredTo: input.to,
        restoredAt: new Date(now),
        retired,
      });
    } catch (error) {
      // The live site is moving onto the copy, but the registry still names the database it
      // had: the next publish puts the settings back, and the copy waits until a deploy after it.
      await markStale(deps.db, backend.siteId);
      await retire(deps.db, backend.siteId, copy.tursoDbName, deps.now?.() ?? Date.now());
      throw error;
    }
    await audit(deps.db, ctx, client, "site.backend.restore", {
      siteId: backend.siteId,
      restoredTo: input.to.toISOString(),
      from: backend.tursoDbName,
      to: copy.tursoDbName,
    });
    await sweepRetired({ ...deps, provisioner }, client, { ...backend, ...copy }, switchedAt);
    return { redeployed };
  } finally {
    await letGo(deps.db, backend.siteId, until);
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
  const { restore, backend, until } = await holdSite(deps.db, found, now);
  try {
    if (
      !restore.keptDbName ||
      !restore.keptDbHostname ||
      restore.keptDbName === backend.tursoDbName
    ) {
      throw new ConnectError("There's no restore to undo.");
    }
    const kept = { tursoDbName: restore.keptDbName, tursoDbHostname: restore.keptDbHostname };
    // A publish since the restore may have changed the database in ways the older one lacks.
    const missing = await migrationsMissing(provisioner, backend, kept);
    if (missing.length > 0) {
      throw new ConnectError(
        `A publish since the restore changed the database (${missing.join(", ")}), and the database from before doesn't have those changes, so the restore can't be undone.`,
      );
    }
    const { redeployed, switchedAt } = await moveLiveSite(
      { ...deps, provisioner },
      client,
      backend.siteId,
      kept,
      backend,
    );
    await commitSwap(deps.db, backend.siteId, until, kept, {
      currentSince: restore.keptSince ?? backend.createdAt,
      keptDbName: null,
      keptDbHostname: null,
      keptSince: null,
      restoredTo: null,
      restoredAt: null,
      retired: [
        ...restore.retired,
        {
          dbName: backend.tursoDbName,
          retiredAt: switchedAt,
          deleteAfter: switchedAt + RETIRE_AFTER_MS,
        },
      ],
    }).catch(async (error) => {
      // The live site is moving back, but the registry still names the restored database.
      await markStale(deps.db, backend.siteId);
      throw error;
    });
    await audit(deps.db, ctx, client, "site.backend.restore.undo", {
      siteId: backend.siteId,
      from: backend.tursoDbName,
      to: kept.tursoDbName,
    });
    await sweepRetired({ ...deps, provisioner }, client, { ...backend, ...kept }, switchedAt);
    return { redeployed };
  } finally {
    await letGo(deps.db, backend.siteId, until);
  }
}

/**
 * Gives the site's database a new key, for owners and admins: every key made for it so far
 * stops working (a leaked one included), and the live site gets the new one and is deployed
 * again. Until that deployment is ready, the live site can't reach its database. A site that
 * isn't published yet gets the new key with its first publish. Callers confirm first.
 */
export async function resetSiteDatabaseKey(
  deps: SiteRestoreDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<{ redeployed: boolean }> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  await clientSite(deps.db, client, input.siteId);
  const found = await siteBackendOf(deps.db, client, input.siteId);
  if (!found) throw new ConnectError("This site doesn't have a database.");
  const provisioner = needsProvisioner(deps);
  const { restore, backend, until } = await holdSite(deps.db, found, deps.now?.() ?? Date.now());
  try {
    try {
      await provisioner.revokeTokens(backend.tursoDbName);
      // The databases a restore replaced had the same key while they were live, and undo
      // can bring one back, so theirs go too. One already deleted has nothing to revoke.
      for (const name of [restore.keptDbName, ...restore.retired.map((r) => r.dbName)]) {
        if (!name || name === backend.tursoDbName) continue;
        await provisioner.revokeTokens(name).catch((error) => {
          if (!(error instanceof TursoError && error.status === 404)) throw error;
        });
      }
    } catch (error) {
      if (!(error instanceof TursoError)) throw error;
      // Turso may have reset it before failing: the next publish gives the site a fresh key.
      await markStale(deps.db, backend.siteId);
      throw new ConnectError(
        "Turso didn't confirm the key reset. Try again; until then, publishing the site gives it a working key.",
      );
    }
    await audit(deps.db, ctx, client, "site.backend.key.reset", {
      siteId: backend.siteId,
      dbName: backend.tursoDbName,
    });
    const projectId = await siteProjectId(deps.db, client, backend.siteId);
    if (!projectId) return { redeployed: false };
    // From here the live site's key is dead, so a step that fails leaves it to the next publish.
    try {
      const env = await projectEnv(deps, client, projectId);
      await writeSiteDatabaseEnv(deps, env, projectId, provisioner, backend);
    } catch {
      await markStale(deps.db, backend.siteId);
      throw new ConnectError(
        "The old key is reset, but Vercel didn't take the new one. Publish the site to finish.",
      );
    }
    try {
      await deployProduction(
        deps,
        await projectEnv(deps, client, projectId),
        client,
        backend.siteId,
        projectId,
      );
    } catch {
      throw new ConnectError(
        "The new key is saved on the site, but Vercel didn't deploy it again. Publish the site to finish.",
      );
    }
    return { redeployed: true };
  } finally {
    await letGo(deps.db, backend.siteId, until);
  }
}
