import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type AuthorizedClient, assertAuthorizedClient } from "@locus/auth";
import { type ControlDb, MAX_SITE_FILE_BYTES, SITE_FILE_TYPES } from "@locus/db";
import { location, site, siteBackend } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";

// Files an app-style site keeps: what its members upload (photos, documents). They live in one
// private Vercel Blob store on Otaku's account, each site under its own `sites/<siteId>/`
// folder. The site never holds a storage credential:
//
//   browser → the site's own route (checks the member) → Locus /api/sites/<siteId>/files/...
//
// The site's route proves it is that site with `SITE_FILES_KEY`, a key Locus derives for each
// site and sets on its host when it is published. Locus answers an upload with a client token
// for one new file under the site's folder (size and type capped, ten minutes), so the browser
// sends the file straight to storage; reads and deletes go through Locus by path, and only
// paths under the site's own folder are accepted. Which client the site belongs to comes from
// its registry row, never from the request.

export { MAX_SITE_FILE_BYTES, SITE_FILE_TYPES };

/** How long an upload token lives. */
const UPLOAD_TTL_MS = 10 * 60 * 1000;

/** The storage behind every site's files. One store; each site has its own folder in it. */
export interface SiteFileStore {
  /** A client token that lets the browser upload exactly one file at `pathname`. */
  uploadToken(input: {
    pathname: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }): Promise<string>;
  /** The file's bytes, or null when there is none. */
  read(pathname: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    size: number | null;
  } | null>;
  delete(pathnames: string[]): Promise<void>;
  /** One page of the files under `prefix`, newest first is not promised. */
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ files: StoredSiteFile[]; cursor: string | null }>;
}

export interface StoredSiteFile {
  pathname: string;
  size: number;
  uploadedAt: Date;
}

export interface SiteFilesDeps {
  db: ControlDb;
  store: SiteFileStore;
  /** The key the files key of every site is derived from (`deriveSecretsSubkey`). */
  filesKey: Uint8Array;
  now?: () => number;
}

/** The site's files key. Derived, so it lives nowhere but on the site's host. */
export function siteFilesKey(filesKey: Uint8Array, siteId: string): string {
  return createHmac("sha256", filesKey).update(`site-files:${siteId}`).digest("base64url");
}

/** Where a site's files live in the store. */
export const siteFilesFolder = (siteId: string) => `sites/${siteId}/`;

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A file name that is safe in a path: letters, digits, dot, dash and underscore. */
function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .slice(-80)
    .replace(/^[.-]+/, "");
  return cleaned || "file";
}

/**
 * How a member's file is sent back: with its own type, never sniffed, never run as a page, and
 * downloaded rather than shown unless it is a picture or a PDF.
 */
export function siteFileHeaders(contentType: string): Record<string, string> {
  const pdf = contentType === "application/pdf";
  const shown = pdf || contentType.startsWith("image/");
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    // Browsers won't open a PDF under a sandbox policy; a PDF can't run the site's scripts.
    ...(pdf ? {} : { "content-security-policy": "sandbox; default-src 'none'" }),
    ...(shown ? {} : { "content-disposition": "attachment" }),
  };
}

export type SiteFileAnswer =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 401 | 404 | 413 | 415; body: { error: string } };

const refuse = (status: 400 | 401 | 404 | 413 | 415, error: string): SiteFileAnswer => ({
  status,
  body: { error },
});

/**
 * Checks that the call comes from the site itself (its files key) and that the site is an
 * app-style site of an active client. Every answer for a wrong key, a site without files or
 * an unknown site is the same 401, so the route reveals nothing about other sites.
 */
async function siteFor(deps: SiteFilesDeps, siteId: string, authorization: string | null) {
  const given = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!given || !sameKey(given, siteFilesKey(deps.filesKey, siteId))) return null;
  const [row] = await deps.db
    .select({ siteId: siteBackend.siteId, status: location.status })
    .from(siteBackend)
    .innerJoin(site, eq(site.id, siteBackend.siteId))
    .innerJoin(location, eq(location.id, siteBackend.locationId))
    .where(and(eq(siteBackend.siteId, siteId), eq(site.locationId, siteBackend.locationId)));
  return row?.status === "active" ? row.siteId : null;
}

/**
 * A path the site named, if it is one of its own files. Only the exact shape Locus hands out
 * is accepted (`sites/<siteId>/<uuid>/<safe name>`): storage builds a URL from the path, and
 * a URL parser turns `%2e%2e` or `\\` into a step up into another site's folder.
 */
function ownPath(siteId: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const rest = value.startsWith(siteFilesFolder(siteId))
    ? value.slice(siteFilesFolder(siteId).length)
    : null;
  return rest !== null && OWN_FILE.test(rest) ? value : null;
}

/** `<uuid>/<name>`, the name as `safeName` makes it. */
const OWN_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[\w-][\w.-]{0,79}$/;

/** A new upload: the client token and where the file will be. */
export async function startSiteFileUpload(
  deps: SiteFilesDeps,
  input: { siteId: string; authorization: string | null; body: unknown },
): Promise<SiteFileAnswer> {
  const siteId = await siteFor(deps, input.siteId, input.authorization);
  if (!siteId) return refuse(401, "This site can't keep files.");
  const body = (input.body ?? {}) as { name?: unknown; contentType?: unknown; size?: unknown };
  if (typeof body.name !== "string" || body.name.length > 300) {
    return refuse(400, "Give the file's name.");
  }
  const contentType = typeof body.contentType === "string" ? body.contentType.toLowerCase() : "";
  if (!(SITE_FILE_TYPES as readonly string[]).includes(contentType)) {
    return refuse(415, "That kind of file can't be uploaded here.");
  }
  if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 1) {
    return refuse(400, "Give the file's size in bytes.");
  }
  if (body.size > MAX_SITE_FILE_BYTES) {
    return refuse(413, `Files can be up to ${MAX_SITE_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const pathname = `${siteFilesFolder(siteId)}${randomUUID()}/${safeName(body.name)}`;
  const validUntil = (deps.now?.() ?? Date.now()) + UPLOAD_TTL_MS;
  const token = await deps.store.uploadToken({
    pathname,
    contentType,
    maxBytes: Math.min(body.size, MAX_SITE_FILE_BYTES),
    validUntil,
  });
  return { status: 200, body: { pathname, token, validUntil, contentType } };
}

/** One of the site's files, for the site's route to stream to its member. */
export async function readSiteFile(
  deps: SiteFilesDeps,
  input: { siteId: string; authorization: string | null; pathname: unknown },
): Promise<
  | { status: 200; body: ReadableStream<Uint8Array>; contentType: string; size: number | null }
  | Exclude<SiteFileAnswer, { status: 200 }>
> {
  const siteId = await siteFor(deps, input.siteId, input.authorization);
  if (!siteId) return { status: 401, body: { error: "This site can't keep files." } };
  const pathname = ownPath(siteId, input.pathname);
  if (!pathname) return { status: 404, body: { error: "There's no such file." } };
  const file = await deps.store.read(pathname);
  if (!file) return { status: 404, body: { error: "There's no such file." } };
  return { status: 200, ...file };
}

/** Deletes some of the site's files. Paths that aren't the site's are refused, all or none. */
export async function deleteSiteFiles(
  deps: SiteFilesDeps,
  input: { siteId: string; authorization: string | null; body: unknown },
): Promise<SiteFileAnswer> {
  const siteId = await siteFor(deps, input.siteId, input.authorization);
  if (!siteId) return refuse(401, "This site can't keep files.");
  const given = (input.body as { pathnames?: unknown } | null)?.pathnames;
  if (!Array.isArray(given) || given.length === 0 || given.length > 100) {
    return refuse(400, "Give the paths of up to 100 files to delete.");
  }
  const pathnames = given.map((value) => ownPath(siteId, value));
  if (pathnames.some((p) => p === null)) return refuse(400, "That isn't one of this site's files.");
  await deps.store.delete(pathnames as string[]);
  return { status: 200, body: { deleted: pathnames.length } };
}

/** The site's files, a page at a time, for the Database page. Anyone on the client may look. */
export async function siteFilesOverview(
  deps: Pick<SiteFilesDeps, "db" | "store">,
  client: AuthorizedClient,
  input: { siteId: string; cursor?: string },
): Promise<{ files: StoredSiteFile[]; cursor: string | null }> {
  assertAuthorizedClient(client);
  // The site's backend row, scoped by the session's client (not `siteBackendOf`, which would
  // make the two modules import each other).
  const [backend] = await deps.db
    .select({ siteId: siteBackend.siteId })
    .from(siteBackend)
    .where(
      and(eq(siteBackend.siteId, input.siteId), eq(siteBackend.locationId, client.location.id)),
    );
  if (!backend) throw new ConnectError("This site doesn't keep files.");
  return deps.store.list(siteFilesFolder(backend.siteId), input.cursor);
}

/** Every file of the site, for when its backend goes. */
export async function deleteAllSiteFiles(store: SiteFileStore, siteId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list(siteFilesFolder(siteId), cursor);
    if (page.files.length > 0) await store.delete(page.files.map((f) => f.pathname));
    cursor = page.cursor ?? undefined;
  } while (cursor);
}

/** A store that keeps files in memory: tests, and a deployment without storage set up. */
export function memoryFileStore(): SiteFileStore & {
  files: Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: Date }>;
  tokens: { pathname: string; contentType: string; maxBytes: number; validUntil: number }[];
} {
  const files = new Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: Date }>();
  const tokens: { pathname: string; contentType: string; maxBytes: number; validUntil: number }[] =
    [];
  return {
    files,
    tokens,
    async uploadToken(input) {
      tokens.push(input);
      return `memory-token-${tokens.length}`;
    },
    async read(pathname) {
      const file = files.get(pathname);
      if (!file) return null;
      return {
        body: new Blob([file.bytes as Uint8Array<ArrayBuffer>]).stream(),
        contentType: file.contentType,
        size: file.bytes.byteLength,
      };
    },
    async delete(pathnames) {
      for (const pathname of pathnames) files.delete(pathname);
    },
    async list(prefix) {
      return {
        files: [...files.entries()]
          .filter(([pathname]) => pathname.startsWith(prefix))
          .map(([pathname, file]) => ({
            pathname,
            size: file.bytes.byteLength,
            uploadedAt: file.uploadedAt,
          })),
        cursor: null,
      };
    },
  };
}
