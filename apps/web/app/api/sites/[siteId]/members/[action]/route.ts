import {
  hasSiteFilesKey,
  readLeadBody,
  type SiteFileAnswer,
  siteMemberSignedUp,
} from "@locus/connect";
import { NotConfigured } from "@/lib/locus";
import { siteFilesDeps } from "@/lib/site-files";

/**
 * A published app-style site's members, server to server from the site's own sign-up code. The
 * site proves itself with its key (`Authorization: Bearer`, the same key as its files); the
 * client is read from the site's registry row, never from the request.
 *
 * - `POST signup` `{ email, name? }` → `{ ok: true }`: the member becomes (or is matched to) a
 *   contact in the client's HighLevel sub-account, tagged as a website sign-up
 */
type Params = { params: Promise<{ siteId: string; action: string }> };

const MAX_JSON = 4 * 1024;
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

export async function POST(request: Request, { params }: Params) {
  const { siteId, action } = await params;
  if (action !== "signup") return refused("Not found.", 404);
  const authorization = request.headers.get("authorization");
  try {
    // The key first: nobody else gets Locus to read a body at all.
    if (!hasSiteFilesKey(siteFilesDeps().filesKey, siteId, authorization)) {
      return refused("This site can't send sign-ups.", 401);
    }
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      return refused("Send JSON.", 415);
    }
    const text = await readLeadBody(request.body, MAX_JSON);
    if (text === null) return refused("That's too much to send.", 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refused("Send JSON.", 400);
    }
    return answer(
      await siteMemberSignedUp(siteFilesDeps(), {
        siteId,
        authorization,
        body,
        // Set by the site's server from its host's forwarding header: trusted only for limits.
        visitorIp: request.headers.get("x-locus-visitor-ip"),
      }),
    );
  } catch (error) {
    if (error instanceof NotConfigured) return refused("This site can't send sign-ups yet.", 503);
    console.error(`Site members route failed: ${(error as Error)?.name ?? "Error"}`);
    return refused("The sign-up couldn't be handled just now.", 500);
  }
}
