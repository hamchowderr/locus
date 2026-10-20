import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { claimSiteUploadTicket, keepTicketedFile, type SiteFilesDeps } from "@locus/connect";

// Bigger files members upload on app-style sites. The site's route checked the member and got a
// ticket from Locus for one file; the member's browser sends that file here, to the always-on
// server, because a Vercel function takes at most 4.5 MB. The ticket is claimed before any of
// the body is read, the file is written to a temporary file as it arrives (never held in
// memory), streamed on to the client's Media Library, and deleted.
//
// The ticket (in `x-locus-ticket`, kept out of URLs and so out of proxy logs) is the only
// credential: no cookie is read, so any site's page may send here.

export type SiteUploadDeps = SiteFilesDeps & { ticketKey: Uint8Array };

export const SITE_UPLOAD_PATH = "/site-files/upload";
export const TICKET_HEADER = "x-locus-ticket";

/** Uploads taken at once, across every site: each may be 500 MB of disk. */
const MAX_ACTIVE = 4;
/** Uploads taken at once for one site, so one site can't take every place. */
const MAX_ACTIVE_PER_SITE = 2;
/** A sender that stops sending for this long is cut off, so its partial file goes. */
const IDLE_MS = 60_000;
/**
 * And one that sends too slowly to finish: after a minute's grace, a file must arrive at about
 * 2 Mbit/s (a 500 MB video in about 35 minutes), or it would hold its place for an hour.
 */
const MIN_BYTES_PER_SECOND = 256 * 1024;
const GRACE_MS = 60_000;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "PUT, OPTIONS",
  "access-control-allow-headers": `content-type, ${TICKET_HEADER}`,
  "access-control-max-age": "600",
};

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...cors, "cache-control": "no-store", ...headers } });

const notTheFile = () => answer({ error: "That isn't the file this upload was for." }, 400);

class Refused extends Error {}

/**
 * Writes the body to `path`, refusing past `max` bytes, after `idleMs` without any, or when it
 * hasn't all arrived by `deadlineMs`.
 */
async function saveCapped(
  body: ReadableStream<Uint8Array>,
  path: string,
  max: number,
  idleMs: number,
  deadlineMs: number,
) {
  let seen = 0;
  let idle: NodeJS.Timeout | undefined;
  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  const counted = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      seen += chunk.byteLength;
      if (seen > max) return done(new Refused("too large"));
      wake();
      done(null, chunk);
    },
  });
  const wake = () => {
    clearTimeout(idle);
    idle = setTimeout(() => counted.destroy(new Refused("idle")), idleMs);
  };
  wake();
  const deadline = setTimeout(() => counted.destroy(new Refused("too slow")), deadlineMs);
  try {
    await pipeline(source, counted, createWriteStream(path, { flags: "wx" }));
    return true;
  } catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
  }
}

export function siteUploads(
  deps: SiteUploadDeps,
  logError: (message: string, error?: unknown) => void = console.error,
  {
    maxActive = MAX_ACTIVE,
    maxActivePerSite = MAX_ACTIVE_PER_SITE,
    idleMs = IDLE_MS,
    graceMs = GRACE_MS,
    minBytesPerSecond = MIN_BYTES_PER_SECOND,
  } = {},
) {
  let active = 0;
  const perSite = new Map<string, number>();
  const busy = () =>
    answer({ error: "Too many uploads just now. Try again shortly." }, 503, {
      "retry-after": "30",
    });
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "PUT") return answer({ error: "Not found." }, 404);
    if (active >= maxActive) return busy();
    active++;
    let site: string | null = null;
    let dir: string | null = null;
    try {
      const length = request.headers.get("content-length");
      const declared = length === null ? null : Number(length);
      if (declared !== null && !Number.isSafeInteger(declared)) return notTheFile();
      const contentType = request.headers.get("content-type") ?? "";
      // Claimed before any of the body is read: nobody gets this server to take a file's worth
      // of bytes without a ticket, or two copies with one.
      const claimed = await claimSiteUploadTicket(deps, {
        ticket: request.headers.get(TICKET_HEADER),
        contentType,
        size: declared,
      });
      if ("answer" in claimed) return answer(claimed.answer.body, claimed.answer.status);
      const { claim } = claimed;
      if ((perSite.get(claim.siteId) ?? 0) >= maxActivePerSite) return busy();
      site = claim.siteId;
      perSite.set(site, (perSite.get(site) ?? 0) + 1);
      if (!request.body) return answer({ error: "Send the file." }, 400);
      dir = await mkdtemp(join(tmpdir(), "locus-upload-"));
      const path = join(dir, randomUUID());
      const deadlineMs = graceMs + (claim.size / minBytesPerSecond) * 1000;
      if (!(await saveCapped(request.body, path, claim.size, idleMs, deadlineMs))) {
        return notTheFile();
      }
      const file = await openAsBlob(path, { type: claim.contentType });
      const result = await keepTicketedFile(deps, claim, file);
      return answer(result.body, result.status);
    } catch (error) {
      logError("A site upload failed:", (error as Error)?.name ?? "Error");
      return answer({ error: "The file couldn't be kept just now. Try again." }, 500);
    } finally {
      active--;
      if (site) {
        const left = (perSite.get(site) ?? 1) - 1;
        if (left > 0) perSite.set(site, left);
        else perSite.delete(site);
      }
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

/** The upload path on a server that doesn't take uploads: said in a way the browser can read. */
export function siteUploadsOff(request: Request): Response {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  return answer({ error: "Files can be up to 4 MB here." }, 503);
}
