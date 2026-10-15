import { sandboxFromEnv } from "@locus/sandbox";
import { configured, locus } from "@/lib/locus";
import { sandboxRpcHandler } from "@/lib/sandbox-rpc";
import { siteRuntimes } from "@/lib/site-builder-host";

/**
 * Sandbox calls from a Locus backend off Vercel (`RemoteRuntimeProvider`, see
 * `packages/sandbox/README.md`). Every call carries an agent-to-web token and is checked by
 * `sandboxRpcHandler` before a sandbox is opened; never serve this route without that check.
 *
 * In production it answers 404 unless `BETTER_AUTH_SECRET` is set and real sandboxes are
 * configured (Vercel OIDC or `LOCUS_SANDBOX_TOKEN`...), so it never fronts the fake or the
 * unconfigured provider. Outside production the fake serves it, for local runs of the agent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// An install may take several minutes. 300 s is the most every Vercel plan allows with Fluid
// compute (Hobby's cap); Pro allows up to 800.
export const maxDuration = 300;

const notFound = () => new Response("Not Found", { status: 404 });

export async function POST(request: Request) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !configured()) return notFound();
  if (process.env.NODE_ENV === "production" && !sandboxFromEnv(process.env)) return notFound();
  return sandboxRpcHandler({ db: locus().db, provider: siteRuntimes(), authSecret: secret })(
    request,
  );
}
