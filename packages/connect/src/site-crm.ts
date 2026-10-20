import { type GhlRequestOptions, type GhlSession, ghlRequest, sharedRateLimiter } from "@locus/ghl";
import { operationById } from "@locus/skills";

// What the site builder may read from the client's sub-account to wire a site into it:
// calendars to book on, and images from the Media Library (a logo for the favicon, a photo for
// link previews). Read-only, through the session's own client (the host passes a session minted
// after the staff check), never cached. Names are the client's own text, so the builder screens
// them as data before the model sees them.
//
// A Media Library image is copied into the site (its own repository serves it), downloaded
// here, not in the sandbox: only from the file's address as GHL lists it for this sub-account,
// never one the model names, only from GHL's own storage hosts, only an image, and no bigger
// than a site file may be.

/** A calendar the builder can put on a site. */
export interface CrmCalendar {
  id: string;
  name: string;
  /** GHL's calendar kind: event, round_robin, class_booking, service_booking, … */
  type: string;
  /** GHL's own booking page for it, for an embedded calendar. */
  embedUrl: string;
}

/** An image in the client's Media Library. */
export interface CrmMedia {
  id: string;
  name: string;
  /**
   * Its type, from its name: png, jpg, webp, gif or ico. SVGs are left out: one can carry
   * script, which a site would then serve from its own address.
   */
  format: MediaFormat;
}

/** A Media Library image, downloaded. */
export interface CrmMediaFile {
  name: string;
  format: MediaFormat;
  bytes: Uint8Array;
}

/** The sub-account reads the builder uses. */
export interface SiteCrm {
  calendars(): Promise<CrmCalendar[]>;
  /** Images, newest first; `search` matches names. */
  media(search?: string): Promise<CrmMedia[]>;
  /** One image from `media`, by id, downloaded. */
  mediaFile(id: string): Promise<CrmMediaFile>;
}

/** A Media Library read the builder can explain to the person. */
export class CrmMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmMediaError";
  }
}

export const MEDIA_FORMATS = ["png", "jpg", "webp", "gif", "ico"] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];

/** Content types each format may arrive as. */
const MEDIA_TYPES: Record<MediaFormat, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg", "image/jpg"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  ico: ["image/x-icon", "image/vnd.microsoft.icon", "image/ico"],
};

/** The largest image copied into a site: a site file's limit. */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
/** How many of the newest files are searched for an id. */
const MEDIA_SCAN = 500;
const MEDIA_PAGE = 100;

/**
 * GHL's own file storage. A listed file's address must be on one of these, over https; any
 * other address is refused, so a planted address can't make Locus fetch something else.
 */
export function isGhlStorageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host === "storage.googleapis.com") return url.pathname.startsWith("/msgsndr/");
  return (
    host === "assets.cdn.filesafe.space" ||
    host === "images.leadconnectorhq.com" ||
    host.endsWith(".filesafe.space") ||
    host.endsWith(".leadconnectorhq.com") ||
    host.endsWith(".msgsndr.com")
  );
}

/** The image format a file name says, or null for anything else. */
export function mediaFormat(name: string): MediaFormat | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/)?.[1];
  if (!ext) return null;
  if (ext === "jpeg") return "jpg";
  return (MEDIA_FORMATS as readonly string[]).includes(ext) ? (ext as MediaFormat) : null;
}

interface ListedMedia {
  id: string;
  name: string;
  url: string;
  format: MediaFormat;
}

/** GHL's file objects are undocumented beyond "File Objects"; read them defensively. */
function listedMedia(raw: unknown): ListedMedia | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const id = typeof f._id === "string" ? f._id : typeof f.id === "string" ? f.id : "";
  const name = typeof f.name === "string" ? f.name.slice(0, 200) : "";
  const url = typeof f.url === "string" ? f.url : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(id) || !isGhlStorageUrl(url)) return null;
  if (f.type !== undefined && f.type !== "file") return null;
  const format = mediaFormat(name) ?? mediaFormat(new URL(url).pathname);
  if (!format) return null;
  return { id, name: name || id, url, format };
}

async function listMediaPage(
  session: GhlSession,
  options: GhlRequestOptions,
  offset: number,
  search?: string,
): Promise<{ files: ListedMedia[]; more: boolean }> {
  const op = operationById("medias.fetch-media-content");
  if (!op) throw new Error("The skill catalog is missing medias.fetch-media-content");
  const found = await ghlRequest<{ files?: unknown[] }>(
    op,
    session,
    {
      query: {
        type: "file",
        sortBy: "createdAt",
        sortOrder: "desc",
        offset: String(offset),
        limit: String(MEDIA_PAGE),
        ...(search ? { query: search.slice(0, 100) } : {}),
      },
    },
    options,
  );
  const raw = Array.isArray(found.files) ? found.files : [];
  return {
    files: raw.map(listedMedia).filter((f): f is ListedMedia => f !== null),
    more: raw.length >= MEDIA_PAGE,
  };
}

/** The client's Media Library images, newest first (the first page only). */
export async function listMedia(
  session: GhlSession,
  options: GhlRequestOptions = {},
  search?: string,
): Promise<CrmMedia[]> {
  const { files } = await listMediaPage(session, options, 0, search);
  return files.map(({ id, name, format }) => ({ id, name, format }));
}

/**
 * Downloads one Media Library image by id: found in this sub-account's own listing (the newest
 * `MEDIA_SCAN` files), then fetched from GHL's storage, checked to be the image it says it is.
 */
export async function downloadMedia(
  session: GhlSession,
  options: GhlRequestOptions,
  id: string,
  download: typeof fetch = fetch,
): Promise<CrmMediaFile> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new CrmMediaError("That isn't a media id.");
  let file: ListedMedia | undefined;
  for (let offset = 0; offset < MEDIA_SCAN && !file; offset += MEDIA_PAGE) {
    const page = await listMediaPage(session, options, offset);
    file = page.files.find((f) => f.id === id);
    if (!page.more) break;
  }
  if (!file) {
    throw new CrmMediaError(`There's no image with id ${id} in the client's Media Library.`);
  }
  const response = await download(file.url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response?.ok || !response.body) {
    throw new CrmMediaError(`${file.name} couldn't be downloaded from the Media Library.`);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (!type || !MEDIA_TYPES[file.format].includes(type)) {
    await response.body.cancel().catch(() => {});
    throw new CrmMediaError(`${file.name} isn't the ${file.format} image its name says.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MEDIA_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CrmMediaError(`${file.name} is larger than 4 MB; pick a smaller image.`);
    }
    chunks.push(value);
  }
  return { name: file.name, format: file.format, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

/** GHL's hosted booking widget for one calendar (its "permanent link"). */
export const calendarEmbedUrl = (calendarId: string) =>
  `https://api.leadconnectorhq.com/widget/booking/${encodeURIComponent(calendarId)}`;

/** The client's active calendars, in GHL's order. */
export async function listCalendars(
  session: GhlSession,
  options: GhlRequestOptions = {},
): Promise<CrmCalendar[]> {
  const op = operationById("calendars.get-calendars");
  if (!op) throw new Error("The skill catalog is missing calendars.get-calendars");
  const found = await ghlRequest<{ calendars?: Record<string, unknown>[] }>(
    op,
    session,
    { query: { showDrafted: false } },
    options,
  );
  const calendars: CrmCalendar[] = [];
  for (const c of found.calendars ?? []) {
    const id = typeof c.id === "string" ? c.id : "";
    if (!/^[A-Za-z0-9]{1,64}$/.test(id) || c.isActive === false) continue;
    calendars.push({
      id,
      name: typeof c.name === "string" ? c.name.slice(0, 120) : "",
      type: typeof c.calendarType === "string" ? c.calendarType.slice(0, 40) : "",
      embedUrl: calendarEmbedUrl(id),
    });
  }
  return calendars;
}

/**
 * The builder's reads for one client. `open` mints the client's GHL session for each read (the
 * host's `clientGhlSession`, after the staff check) and says how to reach GHL; nothing is kept
 * between reads. `download` fetches Media Library files (tests pass a fake).
 */
export function siteCrm(
  open: () => Promise<{ session: GhlSession; http?: Pick<GhlRequestOptions, "fetch" | "baseUrl"> }>,
  download: typeof fetch = fetch,
): SiteCrm {
  const opened = async () => {
    const { session, http } = await open();
    return { session, options: { ...http, rateLimiter: sharedRateLimiter } };
  };
  return {
    calendars: async () => {
      const { session, options } = await opened();
      return listCalendars(session, options);
    },
    media: async (search) => {
      const { session, options } = await opened();
      return listMedia(session, options, search);
    },
    mediaFile: async (id) => {
      const { session, options } = await opened();
      return downloadMedia(session, options, id, download);
    },
  };
}
