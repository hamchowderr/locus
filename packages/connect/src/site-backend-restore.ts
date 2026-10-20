import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import { SITE_DATABASE_ENV, siteDbName, TursoError } from "@locus/db";
import { site, siteBackend, siteBackendRestore } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  clientSite,
  projectEnv,
  type SiteBackendRow,
  type SiteReleaseDeps,
  servesProduction,
  siteBackendOf,
  siteProjectId,
} from "./site-backend.ts";
import { audit } from "./sites.ts";
import { refused, vercel } from "./vercel-api.ts";

// Backups of an app-style site's database are Turso's own: it keeps every database's history
// (24 hours on the free plan, longer on paid ones), so nothing extra is stored or paid for.
// A restore copies the database as it was at a chosen moment into a new database (Turso can't
// restore in place), moves the live site onto that one, and keeps the database it replaced,
// so the restore can be undone. Only the latest replaced database is kept.

/** How far back a site's database can be restored: what Turso's free plan keeps. */
export const SITE_RESTORE_WINDOW_MS = 24 * 3_600_000;

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

const ANOTHER_CHANGE = "Another change to the site's database just happened. Try again.";

async function restoreRow(deps: Pick<SiteRestoreDeps, "db">, siteId: string) {
  const [row] = await deps.db
    .select()
    .from(siteBackendRestore)
    .where(eq(siteBackendRestore.siteId, siteId));
  return row ?? null;
}

/** What the Database page offers: how far back a restore can go, and whether one can be undone. */
export async function siteRestoreState(
  deps: Pick<SiteRestoreDeps, "db" | "now" | "restoreWindowMs">,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteRestoreState | null> {
  const backend = await siteBackendOf(deps.db, client, siteId);
  if (!backend) return null;
  const restore = await restoreRow(deps, backend.siteId);
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

/**
 * Points the site's Vercel project at another of its databases: replaces the live site's
 * database address and token (the login secret and files key stay), then deploys production
 * again so the live site uses it. Does nothing for a site without a project. Returns whether
 * the new deployment was asked for.
 */
async function pointSiteAt(
  deps: SiteRestoreDeps,
  client: AuthorizedClient,
  siteId: string,
  target: { dbName: string; hostname: string },
): Promise<boolean> {
  const projectId = await siteProjectId(deps.db, client, siteId);
  if (!projectId) return false;
  const provisioner = deps.provisioner;
  if (!provisioner)
    throw new ConnectError("This site's database isn't set up on this deployment yet.");
  const env = await projectEnv(deps, client, projectId);
  const replaced = new Set<string>([SITE_DATABASE_ENV.url, SITE_DATABASE_ENV.token]);
  const body = [
    { key: SITE_DATABASE_ENV.url, value: provisioner.url(target.hostname) },
    {
      key: SITE_DATABASE_ENV.token,
      value: await provisioner.mintToken(target.dbName, { ttl: "never" }),
    },
  ].map((v) => ({ ...v, type: "sensitive", target: ["production"] }));
  for (const variable of env.ours.filter((v) => replaced.has(v.key) && servesProduction(v))) {
    const gone = await vercel(
      env.deps,
      env.grant,
      "DELETE",
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variable.id)}`,
    );
    if (!gone.ok && gone.status !== 404) {
      throw refused(gone, "Vercel didn't change the site's database settings. Try again.");
    }
  }
  const added = await vercel<{ failed?: unknown[] }>(env.deps, env.grant, "POST", env.path, {
    body,
  });
  if (!added.ok || (added.body.failed?.length ?? 0) > 0) {
    throw refused(added, "Vercel didn't take the site's database settings. Try again.");
  }

  // Settings reach the live site with its next deployment: ask for one from its repository.
  const [row] = await deps.db
    .select({ repoFullName: site.repoFullName })
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  const [owner, repo] = (row?.repoFullName ?? "").split("/");
  if (!owner || !repo) return false;
  const project = await vercel<{ name?: string; link?: { productionBranch?: string } }>(
    env.deps,
    env.grant,
    "GET",
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );
  if (!project.ok) return false;
  const deployed = await vercel(env.deps, env.grant, "POST", "/v13/deployments", {
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
  });
  return deployed.ok;
}

/** Moves the site's registry row onto `to`, only if it still names `from`. */
async function swapRow(
  deps: Pick<SiteRestoreDeps, "db">,
  backend: SiteBackendRow,
  to: { dbName: string; hostname: string },
): Promise<boolean> {
  const swapped = await deps.db
    .update(siteBackend)
    .set({ tursoDbName: to.dbName, tursoDbHostname: to.hostname })
    .where(
      and(eq(siteBackend.siteId, backend.siteId), eq(siteBackend.tursoDbName, backend.tursoDbName)),
    )
    .returning({ siteId: siteBackend.siteId });
  return swapped.length > 0;
}

/**
 * Moves the live site, then the registry row, onto `to`. A settings change that fails part way
 * reaches nothing live (the site reads them when it deploys) and the next publish fills in
 * what's missing. If another change moved the row first, the site goes back to the database
 * the row now names.
 */
async function swapTo(
  deps: SiteRestoreDeps,
  client: AuthorizedClient,
  backend: SiteBackendRow,
  to: { dbName: string; hostname: string },
): Promise<boolean> {
  const redeployed = await pointSiteAt(deps, client, backend.siteId, to);
  if (await swapRow(deps, backend, to)) return redeployed;
  const now = await siteBackendOf(deps.db, client, backend.siteId);
  if (now) {
    await pointSiteAt(deps, client, backend.siteId, {
      dbName: now.tursoDbName,
      hostname: now.tursoDbHostname,
    }).catch(() => {});
  }
  throw new ConnectError(ANOTHER_CHANGE);
}

/**
 * Restores the site's database to how it was at `to`, for owners and admins: everything
 * written after that moment is gone from the live site, though the database it had until now
 * is kept, so `undoSiteBackendRestore` brings it back. Callers confirm with the person first.
 * Returns whether the live site was redeployed onto the restored database (a site that isn't
 * published yet gets it with its first publish).
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
  const backend = await siteBackendOf(deps.db, client, input.siteId);
  if (!backend) throw new ConnectError("This site doesn't have a database.");
  const provisioner = deps.provisioner;
  if (!provisioner)
    throw new ConnectError("This site's database isn't set up on this deployment yet.");
  const state = await siteRestoreState(deps, client, backend.siteId);
  const now = deps.now?.() ?? Date.now();
  const to = input.to.getTime();
  if (!Number.isFinite(to) || !state || to < state.earliest.getTime() || to > now) {
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
  let redeployed: boolean;
  try {
    redeployed = await swapTo(deps, client, backend, made);
  } catch (error) {
    await provisioner.destroy(made.dbName);
    throw error;
  }

  const earlier = await restoreRow(deps, backend.siteId);
  const values = {
    currentSince: new Date(now),
    keptDbName: backend.tursoDbName,
    keptDbHostname: backend.tursoDbHostname,
    keptSince: earlier?.currentSince ?? backend.createdAt,
    restoredTo: input.to,
    restoredAt: new Date(now),
  };
  await deps.db
    .insert(siteBackendRestore)
    .values({ siteId: backend.siteId, locationId: client.location.id, ...values })
    .onConflictDoUpdate({ target: siteBackendRestore.siteId, set: values });
  // Only the latest replaced database is kept.
  if (earlier?.keptDbName) await provisioner.destroy(earlier.keptDbName);
  await audit(deps.db, ctx, client, "site.backend.restore", {
    siteId: backend.siteId,
    restoredTo: input.to.toISOString(),
    from: backend.tursoDbName,
    to: made.dbName,
  });
  return { redeployed };
}

/**
 * Undoes the site's last restore, for owners and admins: the live site goes back to the
 * database it had before, and the restored one, with anything written to it since, is deleted.
 */
export async function undoSiteBackendRestore(
  deps: SiteRestoreDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<{ redeployed: boolean }> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const backend = await siteBackendOf(deps.db, client, input.siteId);
  const restore = backend ? await restoreRow(deps, backend.siteId) : null;
  if (!backend || !restore?.keptDbName || !restore.keptDbHostname) {
    throw new ConnectError("There's no restore to undo.");
  }
  const provisioner = deps.provisioner;
  if (!provisioner)
    throw new ConnectError("This site's database isn't set up on this deployment yet.");
  const kept = { dbName: restore.keptDbName, hostname: restore.keptDbHostname };
  const redeployed = await swapTo(deps, client, backend, kept);
  await deps.db
    .update(siteBackendRestore)
    .set({
      currentSince: restore.keptSince ?? backend.createdAt,
      keptDbName: null,
      keptDbHostname: null,
      keptSince: null,
      restoredTo: null,
      restoredAt: null,
    })
    .where(eq(siteBackendRestore.siteId, backend.siteId));
  await provisioner.destroy(backend.tursoDbName);
  await audit(deps.db, ctx, client, "site.backend.restore.undo", {
    siteId: backend.siteId,
    from: backend.tursoDbName,
    to: kept.dbName,
  });
  return { redeployed };
}
