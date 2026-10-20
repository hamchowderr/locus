import { type GhlOperation, type GhlRequestOptions, type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";

// The client's GHL Media Library, where files the client owns are kept: what a site's members
// upload and the images the site builder generates. The sub-account's storage is the client's
// own (and free to them), so Locus keeps no files of its own. Every call goes through
// `ghlRequest` with the session's own sub-account; nothing here names a location.

/** A session and how to reach GHL with it, for one client and one request. */
export interface MediaGhl {
  session: GhlSession;
  options: GhlRequestOptions;
}

/** A file or folder in the Media Library. */
export interface MediaItem {
  id: string;
  type: string;
  name: string;
  url: string;
  createdAt: Date | null;
  /** The folder it is in, when GHL says. */
  parentId?: string;
}

/** Files and folders listed per page. */
export const MEDIA_LIST_PAGE = 100;

const MEDIA_ID = /^[A-Za-z0-9]{1,64}$/;

/** A catalog operation of the Media Library, by id. */
export function mediaOp(id: string): GhlOperation {
  const found = operationById(id);
  if (!found) throw new Error(`The skill catalog is missing ${id}`);
  return found;
}

/**
 * GHL's own file storage. A listed file's address must be on one of these, over https; any
 * other address is refused, so a planted address can't make Locus fetch something else. On the
 * bucket every sub-account shares, only this sub-account's own folder counts.
 */
export function isGhlStorageUrl(value: string, locationId?: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host === "storage.googleapis.com") {
    const folder = locationId ? `/msgsndr/${locationId}/` : "/msgsndr/";
    return url.pathname.startsWith(folder);
  }
  return host === "assets.cdn.filesafe.space" || host === "images.leadconnectorhq.com";
}

/** GHL's file objects are only loosely documented; read them defensively. */
function mediaItem(raw: unknown, locationId: string, asked: string): MediaItem | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const id = typeof f._id === "string" ? f._id : typeof f.id === "string" ? f.id : "";
  if (!MEDIA_ID.test(id)) return null;
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
    ...(typeof f.parentId === "string" ? { parentId: f.parentId } : {}),
  };
}

/** One page of the Media Library, newest first. `query` narrows it as GHL's listing allows. */
export async function listMediaItems(
  ghl: MediaGhl,
  query: Record<string, string>,
  offset: number,
): Promise<{ items: MediaItem[]; more: boolean }> {
  const found = await ghlRequest<{ files?: unknown[] }>(
    mediaOp("medias.fetch-media-content"),
    ghl.session,
    {
      query: {
        sortBy: "createdAt",
        sortOrder: "desc",
        offset: String(offset),
        limit: String(MEDIA_LIST_PAGE),
        ...query,
      },
    },
    ghl.options,
  );
  const raw = Array.isArray(found.files) ? found.files : [];
  return {
    items: raw
      .map((f) => mediaItem(f, ghl.session.locationId ?? "-", query.type ?? "file"))
      .filter((f): f is MediaItem => f !== null),
    more: raw.length >= MEDIA_LIST_PAGE,
  };
}

/**
 * The folders with exactly this name, oldest first. There is normally one, made the first time
 * something is kept there; two first uploads at once can make two, and both count.
 */
export async function mediaFoldersNamed(ghl: MediaGhl, name: string): Promise<string[]> {
  const { items } = await listMediaItems(ghl, { type: "folder", query: name }, 0);
  return items
    .filter((f) => f.type === "folder" && f.name === name)
    .reverse()
    .map((f) => f.id);
}

/** The folder with this name that new files go into, made when there is none yet. */
export async function mediaFolder(ghl: MediaGhl, name: string): Promise<string> {
  const [existing] = await mediaFoldersNamed(ghl, name);
  if (existing) return existing;
  const made = await ghlRequest<{ _id?: string; id?: string }>(
    mediaOp("medias.create-media-folder"),
    ghl.session,
    { body: { name } },
    ghl.options,
  );
  const id = made._id ?? made.id;
  if (id && MEDIA_ID.test(id)) return id;
  // GHL's documented answer names no id: find the folder it just made.
  const [found] = await mediaFoldersNamed(ghl, name);
  if (!found) throw new Error("GHL made a folder that can't be found");
  return found;
}

/** GHL kept a file somewhere Locus can't vouch for; it was taken back. */
export class MediaUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaUploadError";
  }
}

/**
 * Uploads one file into a folder of the Media Library (multipart, through `ghlRequest`). A file
 * GHL keeps at an address outside this sub-account's storage is taken back and refused with
 * `MediaUploadError`; a GHL failure throws its `GhlError`.
 */
export async function uploadMedia(
  ghl: MediaGhl,
  input: { file: File; name: string; parentId: string },
  onTakeBackFailed: (error: unknown) => void = () => {},
): Promise<{ fileId: string; url: string }> {
  const sent = await ghlRequest<{ fileId?: string; url?: string }>(
    mediaOp("medias.upload-media-content"),
    ghl.session,
    { body: { file: input.file, name: input.name, parentId: input.parentId } },
    ghl.options,
  );
  const url = sent.url ?? "";
  if (!sent.fileId || !isGhlStorageUrl(url, ghl.session.locationId ?? "-")) {
    // Kept, but not where Locus can vouch for it: take it back rather than leave a stray.
    if (sent.fileId && MEDIA_ID.test(sent.fileId)) {
      await ghlRequest(
        mediaOp("medias.delete-media-content"),
        ghl.session,
        { path: { id: sent.fileId } },
        ghl.options,
      ).catch(onTakeBackFailed);
    }
    throw new MediaUploadError("GHL kept the file at an unexpected address");
  }
  return { fileId: sent.fileId, url };
}
