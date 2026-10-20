import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type AuthorizedClient, assertAuthorizedClient, consumeAttempt } from "@locus/auth";
import {
  MAX_LARGE_SITE_FILE_BYTES,
  MAX_SITE_FILE_BYTES,
  MAX_SITE_VIDEO_BYTES,
  SITE_FILE_TYPES,
  SITE_VIDEO_TYPES,
} from "@locus/db";
import { location, site, siteBackend } from "@locus/db/control";
import { type GhlOperation, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import { isGhlStorageUrl } from "./site-crm.ts";
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

export {
  MAX_LARGE_SITE_FILE_BYTES,
  MAX_SITE_FILE_BYTES,
  MAX_SITE_VIDEO_BYTES,
  SITE_FILE_TYPES,
  SITE_VIDEO_TYPES,
};

/** Uploads a site may make, on top of GHL's own per-client budget. */
export const SITE_FILE_LIMITS: Pick<SiteLeadLimits, "perIp" | "perSiteBurst" | "perSite"> = {
  perSite: { max: 200, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 20, windowMs: 60_000 },
  perIp: { max: 10, windowMs: 10 * 60_000 },
};

/**
 * Tickets for bigger files, counted on top of SITE_FILE_LIMITS: each may be 500 MB, so a site
 * gets far fewer of them.
 */
export const SITE_BIG_FILE_LIMITS: typeof SITE_FILE_LIMITS = {
  perSite: { max: 40, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 5, windowMs: 60_000 },
  perIp: { max: 5, windowMs: 10 * 60_000 },
};

/** The most files one delete may name. */
const MAX_DELETE = 20;
/** Files listed per page, and the most pages read to find a site's file. */
const PAGE = 100;
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
  bigLimits?: Partial<typeof SITE_FILE_LIMITS>;
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
  | { status: 400 | 401 | 403 | 409 | 413 | 415 | 502; body: { error: string } }
  | { status: 429; body: { error: string }; retryAfterSeconds: number };

const refuse = (
  status: 400 | 401 | 403 | 409 | 413 | 415 | 502,
  error: string,
): SiteFileAnswer => ({
  status,
  body: { error },
});

const CANT_KEEP = "This site can't keep files.";

function op(id: string): GhlOperation {
  const found = operationById(id);
  if (!found) throw new Error(`The skill catalog is missing ${id}`);
  return found;
}

/**
 * Checks that the call comes from the site itself (its files key) and that the site is a
 * published app-style site of an active client. Every answer for a wrong key, a site without
 * files or an unknown site is the same 401, so the route reveals nothing about other sites.
 */
export async function siteFor(
  deps: Pick<SiteFilesDeps, "db" | "filesKey">,
  siteId: string,
  authorization: string | null,
) {
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

/** GHL's file objects are only loosely documented; read them defensively. */
function mediaItem(
  raw: unknown,
  locationId: string,
  asked: string,
): (SiteMediaFile & { type: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const id = typeof f._id === "string" ? f._id : typeof f.id === "string" ? f.id : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
  // GHL may leave the type out; then it is what the listing asked for.
  const type = typeof f.type === "string" ? f.type : asked;
  const url = typeof f.url === "string" ? f.url : "";
  if (type === "file" && !isGhlStorageUrl(url, locationId)) return null;
  const name = typeof f.name === "string" ? f.name.slice(0, 200) : "";
  const created = typeof f.createdAt === "string" ? new Date(f.createdAt) : null;
  return {
    id,
    type,
    name: name || id,
    url,
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
  };
}

async function listMedia(
  ghl: SiteGhl,
  query: Record<string, string>,
  offset: number,
): Promise<{ items: (SiteMediaFile & { type: string })[]; more: boolean }> {
  const found = await ghlRequest<{ files?: unknown[] }>(
    op("medias.fetch-media-content"),
    ghl.session,
    {
      query: {
        sortBy: "createdAt",
        sortOrder: "desc",
        offset: String(offset),
        limit: String(PAGE),
        ...query,
      },
    },
    ghl.options,
  );
  const raw = Array.isArray(found.files) ? found.files : [];
  return {
    items: raw
      .map((f) => mediaItem(f, ghl.session.locationId ?? "-", query.type ?? "file"))
      .filter((f): f is SiteMediaFile & { type: string } => f !== null),
    more: raw.length >= PAGE,
  };
}

/**
 * The site's folders in the Media Library, oldest first. There is normally one, made the first
 * time a member uploads; two uploads at once can make two, and every one of them is the site's.
 */
async function siteFolders(ghl: SiteGhl, siteId: string): Promise<string[]> {
  const name = siteFilesFolderName(siteId);
  const { items } = await listMedia(ghl, { type: "folder", query: name }, 0);
  return items
    .filter((f) => f.type === "folder" && f.name === name)
    .reverse()
    .map((f) => f.id);
}

/** The folder new files go into, made when the site has none yet. */
async function uploadFolder(ghl: SiteGhl, siteId: string): Promise<string> {
  const [existing] = await siteFolders(ghl, siteId);
  if (existing) return existing;
  const made = await ghlRequest<{ _id?: string; id?: string }>(
    op("medias.create-media-folder"),
    ghl.session,
    { body: { name: siteFilesFolderName(siteId) } },
    ghl.options,
  );
  const id = made._id ?? made.id;
  if (id && /^[A-Za-z0-9]{1,64}$/.test(id)) return id;
  // GHL's documented answer names no id: find the folder it just made.
  const [found] = await siteFolders(ghl, siteId);
  if (!found) throw new Error("GHL made a folder that can't be found");
  return found;
}

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
      const { items, more } = await listMedia(
        ghl,
        { type: "file", parentId: folderId },
        page * PAGE,
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

/** Why a file of this kind and size can't be kept, or null when it can. */
function fileRefusal(contentType: string, size: number, large: boolean): SiteFileAnswer | null {
  const video = (SITE_VIDEO_TYPES as readonly string[]).includes(contentType);
  if (!video && !(SITE_FILE_TYPES as readonly string[]).includes(contentType)) {
    return refuse(415, "That kind of file can't be uploaded here.");
  }
  if (!Number.isInteger(size) || size < 1) return refuse(400, "That file is empty.");
  const max = !large
    ? MAX_SITE_FILE_BYTES
    : video
      ? MAX_SITE_VIDEO_BYTES
      : MAX_LARGE_SITE_FILE_BYTES;
  if (size > max) return refuse(413, `Files like this can be up to ${max / 1024 / 1024} MB.`);
  return null;
}

const mediaType = (type: string) => type.split(";")[0]?.trim().toLowerCase() ?? "";

async function uploadLimited(
  deps: SiteFilesDeps,
  siteId: string,
  visitorIp: string | null,
  big = false,
): Promise<SiteFileAnswer | null> {
  const now = deps.now?.() ?? Date.now();
  const limits = { ...SITE_FILE_LIMITS, ...deps.limits };
  let wait = await consumeSiteLimits(deps, siteId, visitorIp, limits, now, "file");
  if (wait === null && big) {
    const bigLimits = { ...SITE_BIG_FILE_LIMITS, ...deps.bigLimits };
    wait = await consumeSiteLimits(deps, siteId, visitorIp, bigLimits, now, "file-big");
  }
  if (wait === null) return null;
  return {
    status: 429,
    body: { error: "Too many uploads just now. Try again in a little while." },
    retryAfterSeconds: wait,
  };
}

/** Sends one checked file to the site's folder in its client's Media Library. */
async function keepInMediaLibrary(
  deps: SiteFilesDeps,
  row: NonNullable<Awaited<ReturnType<typeof siteFor>>>,
  file: Blob,
  givenName: string,
  contentType: string,
): Promise<SiteFileAnswer> {
  const ghl = await siteGhl(deps, row.location);
  if (!canWriteMedia(ghl)) return refuse(403, "This site's HighLevel connection can't keep files.");
  const name = safeName(givenName);
  try {
    const folderId = await uploadFolder(ghl, row.site.id);
    const sent = await ghlRequest<{ fileId?: string; url?: string }>(
      op("medias.upload-media-content"),
      ghl.session,
      {
        body: {
          file: new File([file], name, { type: contentType }),
          name,
          parentId: folderId,
        },
      },
      ghl.options,
    );
    const url = sent.url ?? "";
    if (!sent.fileId || !isGhlStorageUrl(url, row.location.ghlLocationId)) {
      // Kept, but not where Locus can vouch for it: take it back rather than leave a stray.
      console.error(`GHL kept a file for site ${row.site.id} at an unexpected address`);
      if (sent.fileId && /^[A-Za-z0-9]{1,64}$/.test(sent.fileId)) {
        await ghlRequest(
          op("medias.delete-media-content"),
          ghl.session,
          { path: { id: sent.fileId } },
          ghl.options,
        ).catch((error) => logGhlFailure(`Taking back a file for site ${row.site.id}`, error));
      }
      return refuse(502, "The file couldn't be kept just now. Try again.");
    }
    return { status: 200, body: { fileId: sent.fileId, url, name, contentType, size: file.size } };
  } catch (error) {
    logGhlFailure(`Uploading a file for site ${row.site.id}`, error);
    return refuse(502, "The file couldn't be kept just now. Try again.");
  }
}

/**
 * A member's upload, sent on to the client's Media Library. `file` is what the site's route
 * forwarded; its type and size are checked here whatever the site already checked. Through
 * Vercel, so at most `MAX_SITE_FILE_BYTES`; bigger files go by ticket (`issueSiteUploadTicket`).
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
  const contentType = mediaType(file.type);
  const refused = fileRefusal(contentType, file.size, false);
  if (refused) return refused;
  const limited = await uploadLimited(deps, row.site.id, input.visitorIp);
  if (limited) return limited;
  return keepInMediaLibrary(deps, row, file, file.name, contentType);
}

// Bigger files skip Vercel: the site's route (which checks the member) asks Locus for a ticket
// for one file of a given name, type and size, and the member's browser sends the file with it
// straight to Locus's own server, which has no request limit of Vercel's. A ticket is signed
// with a key derived for this alone, names its site, lives ten minutes and is used once: the
// server that takes the file claims it before reading any of the body.

const TICKET_TTL_MS = 10 * 60_000;
/** How long a claimed ticket's nonce is remembered: well past any upload it could start. */
const CLAIM_WINDOW_MS = 3 * 60 * 60_000;

interface Ticket {
  /** Site, file name, content type, size, expiry, nonce. */
  s: string;
  n: string;
  t: string;
  z: number;
  e: number;
  r: string;
}

const sign = (key: Uint8Array, payload: string) =>
  createHmac("sha256", key).update(`site-file-ticket:${payload}`).digest("base64url");

function readTicket(key: Uint8Array, value: string, now: number): Ticket | null {
  const [payload, mac] = value.split(".");
  if (!payload || !mac || payload.length > 2000 || !sameKey(mac, sign(key, payload))) return null;
  let ticket: Ticket;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Ticket;
  } catch {
    return null;
  }
  if (
    typeof ticket.s !== "string" ||
    typeof ticket.n !== "string" ||
    typeof ticket.t !== "string" ||
    typeof ticket.z !== "number" ||
    typeof ticket.e !== "number" ||
    typeof ticket.r !== "string" ||
    ticket.e <= now
  ) {
    return null;
  }
  return ticket;
}

/**
 * A ticket for one bigger upload, for the site's route to hand its member's browser with the
 * address to send the file to. `uploadUrl` is null when this deployment has no server that takes
 * big files; the site then sends files of up to `MAX_SITE_FILE_BYTES` the ordinary way.
 */
export async function issueSiteUploadTicket(
  deps: SiteFilesDeps & { ticketKey: Uint8Array; uploadUrl: string | null },
  input: { siteId: string; authorization: string | null; body: unknown; visitorIp: string | null },
): Promise<SiteFileAnswer> {
  const row = await siteFor(deps, input.siteId, input.authorization);
  if (!row) return refuse(401, CANT_KEEP);
  if (!deps.uploadUrl) return { status: 200, body: { uploadUrl: null } };
  const body = (input.body ?? {}) as { name?: unknown; contentType?: unknown; size?: unknown };
  if (typeof body.name !== "string" || body.name.length > 300) {
    return refuse(400, "Give the file's name.");
  }
  // Made safe now, so the ticket stays short whatever the name held.
  const name = safeName(body.name);
  const contentType = typeof body.contentType === "string" ? mediaType(body.contentType) : "";
  const size = typeof body.size === "number" ? body.size : 0;
  const refused = fileRefusal(contentType, size, true);
  if (refused) return refused;
  const limited = await uploadLimited(deps, row.site.id, input.visitorIp, true);
  if (limited) return limited;
  const { ticket, expiresAt } = signSiteUploadTicket(
    deps.ticketKey,
    { siteId: row.site.id, name, contentType, size },
    deps.now?.() ?? Date.now(),
  );
  return { status: 200, body: { uploadUrl: deps.uploadUrl, ticket, contentType, expiresAt } };
}

/** Signs a ticket for one file. Only for a site and file already checked. */
export function signSiteUploadTicket(
  ticketKey: Uint8Array,
  file: { siteId: string; name: string; contentType: string; size: number },
  now: number,
): { ticket: string; expiresAt: number } {
  const expiresAt = now + TICKET_TTL_MS;
  const ticket: Ticket = {
    s: file.siteId,
    n: file.name,
    t: file.contentType,
    z: file.size,
    e: expiresAt,
    r: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return { ticket: `${payload}.${sign(ticketKey, payload)}`, expiresAt };
}

/** A ticket the server taking a file has claimed: the only way to `keepTicketedFile`. */
export interface ClaimedSiteUpload {
  readonly siteId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

const claimed = new WeakSet<ClaimedSiteUpload>();

/**
 * Claims a ticket before any of the file is read: checks it, that the upload says it is what
 * the ticket names, and uses it up, so the same ticket can't send a second copy alongside.
 * `size` is the declared length, when the request has one.
 */
export async function claimSiteUploadTicket(
  deps: Pick<SiteFilesDeps, "db" | "now"> & { ticketKey: Uint8Array },
  input: { ticket: string | null; contentType: string; size: number | null },
): Promise<{ claim: ClaimedSiteUpload } | { answer: SiteFileAnswer }> {
  const now = deps.now?.() ?? Date.now();
  const ticket = input.ticket ? readTicket(deps.ticketKey, input.ticket, now) : null;
  if (!ticket) return { answer: refuse(401, "That upload has expired. Try again.") };
  if (
    mediaType(input.contentType) !== ticket.t ||
    (input.size !== null && input.size !== ticket.z)
  ) {
    return { answer: refuse(400, "That isn't the file this upload was for.") };
  }
  const once = await consumeAttempt(
    deps.db,
    `site-file-ticket|${ticket.r}`,
    { max: 1, windowMs: CLAIM_WINDOW_MS },
    now,
  );
  if (!once.allowed) return { answer: refuse(409, "That upload was already used. Try again.") };
  const claim: ClaimedSiteUpload = Object.freeze({
    siteId: ticket.s,
    name: ticket.n,
    contentType: ticket.t,
    size: ticket.z,
  });
  claimed.add(claim);
  return { claim };
}

/**
 * Keeps a file sent with a claimed ticket. The file must be exactly the size the ticket named,
 * and its site must still keep files.
 */
export async function keepTicketedFile(
  deps: SiteFilesDeps,
  claim: ClaimedSiteUpload,
  file: Blob,
): Promise<SiteFileAnswer> {
  if (!claimed.has(claim)) throw new Error("keepTicketedFile needs a claimed ticket");
  claimed.delete(claim);
  if (file.size !== claim.size) return refuse(400, "That isn't the file this upload was for.");
  const row = await siteFor(
    deps,
    claim.siteId,
    `Bearer ${siteFilesKey(deps.filesKey, claim.siteId)}`,
  );
  if (!row) return refuse(401, CANT_KEEP);
  return keepInMediaLibrary(deps, row, file, claim.name, claim.contentType);
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
        op("medias.delete-media-content"),
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
