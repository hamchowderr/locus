import {
  deleteSiteFiles,
  hasSiteFilesKey,
  MAX_SITE_FILE_BYTES,
  type SiteFileAnswer,
  uploadSiteFile,
} from "@locus/connect";
import { NotConfigured } from "@/lib/locus";
import { siteFilesDeps } from "@/lib/site-files";

/**
 * A published app-style site's files, server to server from the site's own routes, which check
 * the site's member first. The site proves itself with its files key (`Authorization: Bearer`);
 * the client is read from the site's registry row, never from the request. Files go into the
 * client's own Media Library.
 *
 * - `POST upload` multipart `file` → `{ fileId, url, name, contentType, size }`
 * - `POST delete` `{ fileIds }` → `{ deleted }`
 */
type Params = { params: Promise<{ siteId: string; action: string }> };

const MAX_JSON = 16 * 1024;
/** Room for the multipart envelope around the file. */
const MAX_UPLOAD = MAX_SITE_FILE_BYTES + 64 * 1024;
const noStore = { "cache-control": "no-store" };

const refused = (error: string, status: number) =>
  Response.json({ error }, { status, headers: noStore });

const answer = (result: SiteFileAnswer) =>
  Response.json(result.body, {
    status: result.status,
    headers: {
      ...noStore,
      ...("retryAfterSeconds" in result ? { "retry-after": String(result.retryAfterSeconds) } : {}),
    },
  });

async function jsonBody(request: Request): Promise<unknown | Response> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return refused("Send JSON.", 415);
  }
  const text = await request.text();
  if (text.length > MAX_JSON) return refused("That's too much to send.", 413);
  try {
    return JSON.parse(text);
  } catch {
    return refused("Send JSON.", 400);
  }
}

async function uploadedFile(request: Request): Promise<File | null | Response> {
  if (!/^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "")) {
    return refused("Send the file as a form.", 415);
  }
  const length = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isFinite(length) || length > MAX_UPLOAD) {
    return refused(`Files can be up to ${MAX_SITE_FILE_BYTES / 1024 / 1024} MB.`, 413);
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  return file instanceof File ? file : null;
}

function failed(error: unknown): Response {
  if (error instanceof NotConfigured) return refused("This site can't keep files yet.", 503);
  console.error(`Site files route failed: ${(error as Error)?.name ?? "Error"}`);
  return refused("The file couldn't be handled just now.", 500);
}

export async function POST(request: Request, { params }: Params) {
  const { siteId, action } = await params;
  const authorization = request.headers.get("authorization");
  try {
    if (action === "upload") {
      // The key first: nobody else gets Locus to read a file's worth of body.
      if (!hasSiteFilesKey(siteFilesDeps().filesKey, siteId, authorization)) {
        return refused("This site can't keep files.", 401);
      }
      const file = await uploadedFile(request);
      if (file instanceof Response) return file;
      return answer(
        await uploadSiteFile(siteFilesDeps(), {
          siteId,
          authorization,
          file,
          // Set by the site's route from its host's forwarding header; any caller can send it,
          // so it is trusted only for the per-IP limit.
          visitorIp: request.headers.get("x-locus-visitor-ip"),
        }),
      );
    }
    if (action === "delete") {
      const body = await jsonBody(request);
      if (body instanceof Response) return body;
      return answer(await deleteSiteFiles(siteFilesDeps(), { siteId, authorization, body }));
    }
    return refused("Not found.", 404);
  } catch (error) {
    return failed(error);
  }
}
