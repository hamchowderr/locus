import { publishDeps } from "@/lib/hosts";
import { configured } from "@/lib/locus";
import { publishRpcHandler } from "@/lib/publish-rpc";
import { siteBuilderDeps } from "@/lib/site-builder-host";

/**
 * Publish calls from a Locus backend without the GitHub App (`remotePublish`, used by the agent
 * server). Every call carries an agent-to-web token and is checked by `publishRpcHandler` before
 * anything is read or published; never serve this route without that check. It answers 404
 * unless `BETTER_AUTH_SECRET` is set and Locus is configured.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not Found", { status: 404 });

export async function POST(request: Request) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !configured()) return notFound();
  const { db, openClientDb, locusUrl } = siteBuilderDeps();
  return publishRpcHandler({
    db,
    openClientDb,
    publish: publishDeps,
    authSecret: secret,
    locusUrl,
  })(request);
}

// Any other method gets the same bare 404, not Next's 405.
export { notFound as GET, notFound as PUT, notFound as PATCH, notFound as DELETE };
