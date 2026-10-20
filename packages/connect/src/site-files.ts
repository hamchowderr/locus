import { createHmac, timingSafeEqual } from "node:crypto";
import { type AuthorizedClient, assertAuthorizedClient } from "@locus/auth";
import { MAX_SITE_FILE_BYTES, SITE_FILE_TYPES } from "@locus/db";
import { location, site, siteBackend } from "@locus/db/control";
import { ghlRequest } from "@locus/ghl";
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  listMediaItems,
  MEDIA_LIST_PAGE,
  MediaUploadError,
  mediaFolder,
  mediaFoldersNamed,
  mediaOp,
  uploadMedia,
} from "./media-library.ts";
import {
  consumeSiteLimits,
  logGhlFailure,
  type SiteGhl,
  type SiteLeadDeps,
  type SiteLeadLimits,
  siteGhl,
} from "./site-leads.ts";

// Files an app-style site keeps: what its members upload (photos, documents). They go into the
// client's own GHL Media Library, in one folder per site, so they cost Otaku nothing and the
// agency sees them where it keeps every other file. The site never holds a GHL token:
//
//   browser → the site's own route (checks the member) → Locus /api/sites/<siteId>/files/...
//           → the sub-account's Media Library
//
// The site's route proves it is that site with `SITE_FILES_KEY`, a key Locus derives for each
// site and sets on its host when it is published. Which client the files go to comes from the
// site's registry row, never from the request. GHL keeps each file at a public address with a
// random name: anyone who has a file's link can open it, so a site shows links only to members
// its own records allow.

export { MAX_SITE_FILE_BYTES, SITE_FILE_TYPES };

/** Uploads a site may make, on top of GHL's own per-client budget. */
export const SITE_FILE_LIMITS: Pick<SiteLeadLimits, "perIp" | "perSiteBurst" | "perSite"> = {
  perSite: { max: 200, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 20, windowMs: 60_000 },
  perIp: { max: 10, windowMs: 10 * 60_000 },
};

/** The most files one delete may name. */
const MAX_DELETE = 20;
/** The most pages read to find a site's file. */
const MAX_PAGES = 20;

export type SiteFilesDeps = Pick<
  SiteLeadDeps,
  "db" | "secrets" | "ghl" | "http" | "now" | "rateLimiter"
> & {
  /** The key the files key of every site is derived from (`deriveSecretsSubkey`). */
  filesKey: Uint8Array;
  /** Visitor IPs are hashed with this for the per-IP limit, as for site forms. */
  ipHashKey: Uint8Array;
  limits?: Partial<typeof SITE_FILE_LIMITS>;
};

/** A file in the site's folder of the Media Library. */
export interface SiteMediaFile {
  id: string;
  name: string;
  url: string;
  createdAt: Date | null;
}

/** The site's files key. Derived, so it lives nowhere but on the site's host. */
export function siteFilesKey(filesKey: Uint8Array, siteId: string): string {
  return createHmac("sha256", filesKey).update(`site-files:${siteId}`).digest("base64url");
}

/** The site's folder in the client's Media Library. */
export const siteFilesFolderName = (siteId: string) => `Site uploads ${siteId}`;

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a call carries the site's own files key: a cheap check before reading a body. */
export function hasSiteFilesKey(
  filesKey: Uint8Array,
  siteId: string,
  authorization: string | null,
): boolean {
  const given = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  return Boolean(given && sameKey(given, siteFilesKey(filesKey, siteId)));
}

/** A file name that is safe to show and store: letters, digits, dot, dash and underscore. */
function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .slice(-80)
    .replace(/^[.-]+/, "");
  return cleaned || "file";
}

export type SiteFileAnswer =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 401 | 403 | 413 | 415 | 502; body: { error: string } }
  | { status: 429; body: { error: string }; retryAfterSeconds: number };

const refuse = (status: 400 | 401 | 403 | 413 | 415 | 502, error: string): SiteFileAnswer => ({
  status,
  body: { error },
});

const CANT_KEEP = "This site can't keep files.";

/**
 * Checks that the call comes from the site itself (its files key) and that the site is a
 * published app-style site of an active client. Every answer for a wrong key, a site without
 * files or an unknown site is the same 401, so the route reveals nothing about other sites.
 */
async function siteFor(deps: SiteFilesDeps, siteId: string, authorization: string | null) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(siteId)) return null;
  if (!hasSiteFilesKey(deps.filesKey, siteId, authorization)) return null;
  const [row] = await deps.db
    .select({ site, location })
    .from(siteBackend)
    .innerJoin(site, eq(site.id, siteBackend.siteId))
    .innerJoin(location, eq(location.id, siteBackend.locationId))
    .where(and(eq(siteBackend.siteId, siteId), eq(site.locationId, siteBackend.locationId)));
  if (!row || row.site.status === "draft" || row.location.status !== "active") return null;
  return row;
}

/** The site's folders in the Media Library, oldest first (every one with the site's name). */
const siteFolders = (ghl: SiteGhl, siteId: string) =>
  mediaFoldersNamed(ghl, siteFilesFolderName(siteId));

/**
 * The files in the site's folders, newest first per folder, up to `pages` pages in all. With
 * `until`, stops as soon as every one of those ids has been seen.
 */
async function folderFiles(
  ghl: SiteGhl,
  folderIds: string[],
  pages = MAX_PAGES,
  until?: ReadonlySet<string>,
) {
  const files: SiteMediaFile[] = [];
  const seen = () =>
    until !== undefined && [...until].every((id) => files.some((f) => f.id === id));
  let read = 0;
  for (const folderId of folderIds) {
    for (let page = 0; ; page++) {
      if (read >= pages) return { files, more: true };
      read++;
      const { items, more } = await listMediaItems(
        ghl,
        { type: "file", parentId: folderId },
        page * MEDIA_LIST_PAGE,
      );
      for (const { type, ...file } of items) if (type === "file") files.push(file);
      if (seen()) return { files, more };
      if (!more) break;
    }
  }
  return { files, more: false };
}

/** Whether the agency's GHL connection may write to the Media Library. */
const canWriteMedia = (ghl: SiteGhl) => ghl.scopes.includes("medias.write");

/**
 * A member's upload, sent on to the client's Media Library. `file` is what the site's route
 * forwarded; its type and size are checked here whatever the site already checked.
 */
export async function uploadSiteFile(
  deps: SiteFilesDeps,
  input: {
    siteId: string;
    authorization: string | null;
    file: File | null;
    visitorIp: string | null;
  },
): Promise<SiteFileAnswer> {
  const row = await siteFor(deps, input.siteId, input.authorization);
  if (!row) return refuse(401, CANT_KEEP);
  const file = input.file;
  if (!file) return refuse(400, "Send the file.");
  const contentType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(SITE_FILE_TYPES as readonly string[]).includes(contentType)) {
    return refuse(415, "That kind of file can't be uploaded here.");
  }
  if (file.size < 1) return refuse(400, "That file is empty.");
  if (file.size > MAX_SITE_FILE_BYTES) {
    return refuse(413, `Files can be up to ${MAX_SITE_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const limits = { ...SITE_FILE_LIMITS, ...deps.limits };
  const now = deps.now?.() ?? Date.now();
  const wait = await consumeSiteLimits(deps, row.site.id, input.visitorIp, limits, now, "file");
  if (wait !== null) {
    return {
      status: 429,
      body: { error: "Too many uploads just now. Try again in a little while." },
      retryAfterSeconds: wait,
    };
  }
  const ghl = await siteGhl(deps, row.location);
  if (!canWriteMedia(ghl)) return refuse(403, "This site's HighLevel connection can't keep files.");
  const name = safeName(file.name);
  try {
    const folderId = await mediaFolder(ghl, siteFilesFolderName(row.site.id));
    const sent = await uploadMedia(
      ghl,
      { file: new File([file], name, { type: contentType }), name, parentId: folderId },
      (error) => logGhlFailure(`Taking back a file for site ${row.site.id}`, error),
    );
    return {
      status: 200,
      body: { fileId: sent.fileId, url: sent.url, name, contentType, size: file.size },
    };
  } catch (error) {
    if (error instanceof MediaUploadError) {
      console.error(`GHL kept a file for site ${row.site.id} at an unexpected address`);
      return refuse(502, "The file couldn't be kept just now. Try again.");
    }
    logGhlFailure(`Uploading a file for site ${row.site.id}`, error);
    return refuse(502, "The file couldn't be kept just now. Try again.");
  }
}

/**
 * Deletes some of the site's files. Only ids found in the site's folders reach GHL; the others
 * are skipped (already gone, or never the site's), so a retry after a partial failure works.
 */
export async function deleteSiteFiles(
  deps: SiteFilesDeps,
  input: { siteId: string; authorization: string | null; body: unknown },
): Promise<SiteFileAnswer> {
  const row = await siteFor(deps, input.siteId, input.authorization);
  if (!row) return refuse(401, CANT_KEEP);
  const given = (input.body as { fileIds?: unknown } | null)?.fileIds;
  if (
    !Array.isArray(given) ||
    given.length === 0 ||
    given.length > MAX_DELETE ||
    !given.every((id) => typeof id === "string" && /^[A-Za-z0-9]{1,64}$/.test(id))
  ) {
    return refuse(400, `Give the ids of up to ${MAX_DELETE} files to delete.`);
  }
  const ids = [...new Set(given as string[])];
  const limits = { ...SITE_FILE_LIMITS, ...deps.limits };
  const now = deps.now?.() ?? Date.now();
  const wait = await consumeSiteLimits(deps, row.site.id, null, limits, now, "file-delete");
  if (wait !== null) {
    return {
      status: 429,
      body: { error: "Too many deletes just now. Try again in a little while." },
      retryAfterSeconds: wait,
    };
  }
  const ghl = await siteGhl(deps, row.location);
  if (!canWriteMedia(ghl)) return refuse(403, "This site's HighLevel connection can't keep files.");
  try {
    const wanted = new Set(ids);
    const listed = await folderFiles(ghl, await siteFolders(ghl, row.site.id), MAX_PAGES, wanted);
    const mine = ids.filter((id) => listed.files.some((f) => f.id === id));
    for (const id of mine) {
      await ghlRequest(
        mediaOp("medias.delete-media-content"),
        ghl.session,
        { path: { id } },
        ghl.options,
      );
    }
    return { status: 200, body: { deleted: mine.length } };
  } catch (error) {
    logGhlFailure(`Deleting files for site ${row.site.id}`, error);
    return refuse(502, "The files couldn't be deleted just now. Try again.");
  }
}

/**
 * The site's files, newest first, for the Database page. The caller passes a client resolved
 * from the session (staff checked), so the token is minted only for a client they may see.
 */
export async function siteFilesOverview(
  deps: Pick<SiteFilesDeps, "db" | "secrets" | "ghl" | "http" | "now" | "rateLimiter">,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<{ files: SiteMediaFile[]; more: boolean }> {
  assertAuthorizedClient(client);
  const [backend] = await deps.db
    .select({ siteId: siteBackend.siteId })
    .from(siteBackend)
    .where(
      and(eq(siteBackend.siteId, input.siteId), eq(siteBackend.locationId, client.location.id)),
    );
  if (!backend) throw new ConnectError("This site doesn't keep files.");
  const ghl = await siteGhl(deps, client.location);
  if (!ghl.scopes.includes("medias.readonly") && !canWriteMedia(ghl)) {
    throw new ConnectError("This client's HighLevel connection can't read its Media Library.");
  }
  const folders = await siteFolders(ghl, backend.siteId);
  return folderFiles(ghl, folders, folders.length);
}
