import { type AuthorizedClient, assertAuthorizedClient, type SessionContext } from "@locus/auth";
import {
  type SitePage,
  SiteWorkspace,
  sitePages,
  type VersionInfo,
  WorkspaceError,
} from "@locus/studio";
import {
  buildRefusal,
  leaseClientDb,
  SITE_BUILDER_OFF,
  type SiteBuilderDeps,
  SiteInputError,
  siteOfClient,
  siteRuntimeKey,
  usageMeter,
} from "./host.ts";
import { BuilderError } from "./index.ts";
import { syncRuntime } from "./sync.ts";

// The Sites pages' view of a site's history and preview: its saved versions (bookmark,
// restore) and a live preview of the draft or of one version. The client is always the
// session's, after the staff check; the site must be one of its. Anyone with the client may look;
// bookmarking and restoring need the right to build the site (`buildRefusal`), and previews need
// the site builder on for the client, since they run (and bill) a sandbox.

/** How many versions the Versions page lists, newest first. */
export const VERSIONS_SHOWN = 50;

type HistoryDeps = Pick<SiteBuilderDeps, "db" | "openClientDb">;

async function withWorkspace<T>(
  deps: HistoryDeps,
  client: AuthorizedClient,
  siteId: string,
  work: (workspace: SiteWorkspace) => Promise<T>,
  access: "view" | "build" = "view",
): Promise<T> {
  assertAuthorizedClient(client);
  await siteOfClient(deps.db, client, siteId);
  if (access === "build") {
    const refusal = await buildRefusal(deps.db, client, siteId);
    if (refusal) throw new SiteInputError(refusal);
  }
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    return await work(new SiteWorkspace(tenant, siteId));
  } catch (error) {
    if (error instanceof WorkspaceError) throw new SiteInputError(error.message);
    throw error;
  } finally {
    release();
  }
}

export interface SiteHistory {
  versions: VersionInfo[];
  /** The draft has changes no version holds yet (the builder is mid-change, or didn't save). */
  unsaved: boolean;
  /** Versions beyond `VERSIONS_SHOWN` that aren't listed. */
  more: number;
  /** Why the member may not bookmark or restore versions, or null when they may. */
  refusal: string | null;
}

/** A site's saved versions, newest first, and whether the draft has unsaved changes. */
export async function siteHistory(
  deps: HistoryDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteHistory> {
  return withWorkspace(deps, client, siteId, async (workspace) => {
    const all = await workspace.listVersions();
    const changes = all.length > 0 ? await workspace.changes() : null;
    const unsaved =
      !!changes && changes.added.length + changes.modified.length + changes.deleted.length > 0;
    return {
      versions: all.slice(0, VERSIONS_SHOWN),
      unsaved,
      more: Math.max(0, all.length - VERSIONS_SHOWN),
      refusal: await buildRefusal(deps.db, client, siteId),
    };
  });
}

async function versionByNumber(workspace: SiteWorkspace, number: number): Promise<VersionInfo> {
  const version = Number.isInteger(number)
    ? (await workspace.listVersions()).find((v) => v.number === number)
    : undefined;
  if (!version) throw new SiteInputError(`This site has no version ${number}.`);
  return version;
}

/** Bookmarks a version (or takes the bookmark off), so it is easy to find again. */
export async function bookmarkSiteVersion(
  deps: HistoryDeps,
  client: AuthorizedClient,
  siteId: string,
  input: { number: number; bookmarked: boolean },
): Promise<void> {
  await withWorkspace(
    deps,
    client,
    siteId,
    async (workspace) => {
      const version = await versionByNumber(workspace, input.number);
      await workspace.setBookmark(version.id, input.bookmarked);
    },
    "build",
  );
}

/**
 * Goes back to a saved version: its files become the site's again, saved as a new version, so
 * restoring can itself be undone. Changes the builder had not saved yet are first kept as their
 * own version, so nothing is lost. Nothing is published: the Sites page's Publish (or the next
 * save in the chat) sends it.
 */
export async function restoreSiteVersion(
  deps: HistoryDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
  number: number,
): Promise<{ restored: number; version: VersionInfo; kept: VersionInfo | null }> {
  return withWorkspace(
    deps,
    client,
    siteId,
    async (workspace) => {
      const target = await versionByNumber(workspace, number);
      const { version, kept } = await workspace.restoreKeeping(target.id, { userId: ctx.userId });
      return { restored: target.number, version, kept };
    },
    "build",
  );
}

export interface SitePreview {
  url: string;
  pages: SitePage[];
  /** The version shown, or null for the site's current files. */
  version: number | null;
}

/** The sandbox that shows a site's saved versions, apart from the one the builder works in. */
export const versionPreviewKey = (client: AuthorizedClient, siteId: string) =>
  `${siteRuntimeKey(client, siteId)}/versions`;

/** How long a preview may spend installing packages before giving up. */
const INSTALL_MS = 180_000;

/**
 * Starts (or refreshes) the site's live preview in its sandbox, with the current files or one
 * saved version's, and lists its pages. The current files show in the builder's own sandbox;
 * saved versions show in a second sandbox per site, so they never change what the builder runs.
 * Sandbox time is checked against and counted in the client's credits, as in the chat.
 */
export async function startSitePreview(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb" | "runtimes" | "openRuntime">,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
  options: { version?: number | null } = {},
): Promise<SitePreview> {
  assertAuthorizedClient(client);
  if (!client.location.siteBuilder) throw new SiteInputError(SITE_BUILDER_OFF);
  const meter = usageMeter(deps.db, client, { siteId, userId: ctx.userId });
  const verdict = await meter.check();
  if (!verdict.ok) throw new SiteInputError(verdict.reason);
  const { files, version } = await withWorkspace(deps, client, siteId, async (workspace) => {
    if (options.version == null) return { files: await workspace.snapshot(), version: null };
    const target = await versionByNumber(workspace, options.version);
    return { files: await workspace.versionFiles(target.id), version: target.number };
  });
  if (files.length === 0) throw new SiteInputError("This site has no files to preview yet.");
  const started = Date.now();
  try {
    // An older version gets a sandbox of its own, so it never swaps files under the builder.
    const runtime = await (version !== null
      ? deps.runtimes().open(versionPreviewKey(client, siteId))
      : deps.openRuntime
        ? deps.openRuntime(client, siteId)
        : deps.runtimes().open(siteRuntimeKey(client, siteId)));
    await syncRuntime(runtime, files);
    const installed = await runtime.install({ timeoutMs: INSTALL_MS });
    if (installed.exitCode !== 0) {
      throw new SiteInputError(
        "The site's packages didn't install, so it can't be previewed. Ask the site builder to fix it.",
      );
    }
    const { url } = await runtime.startPreview();
    return { url, pages: sitePages(files.map((f) => f.path)), version };
  } catch (error) {
    if (error instanceof BuilderError) throw new SiteInputError(error.message);
    throw error;
  } finally {
    await meter
      .record({ kind: "sandbox", seconds: Math.max(1, Math.ceil((Date.now() - started) / 1000)) })
      .catch((error: unknown) => console.error("Recording preview time failed", error));
  }
}
