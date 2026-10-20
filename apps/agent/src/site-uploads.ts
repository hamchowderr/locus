import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type SiteFilesDeps, siteUploadTicket, uploadSiteFileWithTicket } from "@locus/connect";

// Bigger files members upload on app-style sites. The site's route checked the member and got a
// ticket from Locus for one file; the member's browser sends that file here, to the always-on
// server, because a Vercel function takes at most 4.5 MB. The file is written to a temporary
// file as it arrives (never held in memory), sent on to the client's Media Library, and deleted.
//
// The ticket is the only credential: no cookie is read, so any site's page may send here.

export type SiteUploadDeps = SiteFilesDeps & { ticketKey: Uint8Array };

export const SITE_UPLOAD_PATH = "/site-files/upload";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

const answer = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...cors, "cache-control": "no-store" } });

/** Writes the body to `path`, refusing once it passes `max` bytes. False when it did. */
async function saveCapped(body: ReadableStream<Uint8Array>, path: string, max: number) {
  let seen = 0;
  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  const counted = source.map((chunk: Uint8Array) => {
    seen += chunk.byteLength;
    if (seen > max) throw new RangeError("too large");
    return chunk;
  });
  try {
    await pipeline(counted, createWriteStream(path, { flags: "wx" }));
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function siteUploads(
  deps: SiteUploadDeps,
  logError: (message: string, error?: unknown) => void = console.error,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "PUT") return answer({ error: "Not found." }, 404);
    const value = new URL(request.url).searchParams.get("ticket");
    const startedAt = deps.now?.() ?? Date.now();
    // A cheap look first, so nobody gets this server to take a file's worth of bytes without one.
    const ticket = siteUploadTicket(deps.ticketKey, value, startedAt);
    if (!ticket) return answer({ error: "That upload has expired. Try again." }, 401);
    if (!request.body) return answer({ error: "Send the file." }, 400);
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared !== ticket.size) {
      return answer({ error: "That isn't the file this upload was for." }, 400);
    }
    const dir = await mkdtemp(join(tmpdir(), "locus-upload-"));
    try {
      const path = join(dir, randomUUID());
      if (!(await saveCapped(request.body, path, ticket.size))) {
        return answer({ error: "That isn't the file this upload was for." }, 400);
      }
      const contentType = request.headers.get("content-type") ?? "";
      const file = await openAsBlob(path, { type: contentType });
      const result = await uploadSiteFileWithTicket(deps, {
        ticket: value,
        file,
        contentType,
        startedAt,
      });
      return answer(result.body, result.status);
    } catch (error) {
      logError("A site upload failed:", (error as Error)?.name ?? "Error");
      return answer({ error: "The file couldn't be kept just now. Try again." }, 500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
