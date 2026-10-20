import {
  deleteSiteFiles,
  readSiteFile,
  type SiteFileAnswer,
  startSiteFileUpload,
} from "@locus/connect";
import { NotConfigured } from "@/lib/locus";
import { siteFilesDeps } from "@/lib/site-files";

/**
 * A published app-style site's files, server to server from the site's own routes, which check
 * the site's member first. The site proves itself with its files key (`Authorization: Bearer`);
 * the client is read from the site's registry row, never from the request.
 *
 * - `POST upload` `{ name, contentType, size }` → `{ pathname, token, validUntil }`
 * - `GET read?pathname=…` → the file's bytes
 * - `POST delete` `{ pathnames }` → `{ deleted }`
 */
type Params = { params: Promise<{ siteId: string; action: string }> };

const MAX_BODY = 16 * 1024;
const noStore = { "cache-control": "no-store" };

const answer = (result: SiteFileAnswer) =>
  Response.json(result.body, { status: result.status, headers: noStore });

async function jsonBody(request: Request): Promise<unknown | Response> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return Response.json({ error: "Send JSON." }, { status: 415, headers: noStore });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return Response.json({ error: "That's too much to send." }, { status: 413, headers: noStore });
  }
  try {
    return JSON.parse(text);
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400, headers: noStore });
  }
}

function failed(error: unknown): Response {
  if (error instanceof NotConfigured) {
    return Response.json(
      { error: "File storage isn't set up yet." },
      { status: 503, headers: noStore },
    );
  }
  console.error(`Site files route failed: ${(error as Error)?.name ?? "Error"}`);
  return Response.json(
    { error: "The file couldn't be handled just now." },
    { status: 500, headers: noStore },
  );
}

export async function POST(request: Request, { params }: Params) {
  const { siteId, action } = await params;
  if (action !== "upload" && action !== "delete") {
    return Response.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const authorization = request.headers.get("authorization");
  try {
    const deps = siteFilesDeps();
    return answer(
      action === "upload"
        ? await startSiteFileUpload(deps, { siteId, authorization, body })
        : await deleteSiteFiles(deps, { siteId, authorization, body }),
    );
  } catch (error) {
    return failed(error);
  }
}

export async function GET(request: Request, { params }: Params) {
  const { siteId, action } = await params;
  if (action !== "read") {
    return Response.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  try {
    const result = await readSiteFile(siteFilesDeps(), {
      siteId,
      authorization: request.headers.get("authorization"),
      pathname: new URL(request.url).searchParams.get("pathname"),
    });
    if (result.status !== 200) return answer(result);
    return new Response(result.body, {
      headers: {
        ...noStore,
        "content-type": result.contentType,
        "x-content-type-options": "nosniff",
        ...(result.size === null ? {} : { "content-length": String(result.size) }),
      },
    });
  } catch (error) {
    return failed(error);
  }
}
