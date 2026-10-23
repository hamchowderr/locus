import { sandboxProviderFromEnv } from "@locus/sandbox";
import { configured, locus } from "@/lib/locus";
import { sandboxRpcHandler } from "@/lib/sandbox-rpc";
import { siteRuntimes } from "@/lib/site-builder-host";

/**
 * Sandbox calls from a Locus backend off Vercel (`RemoteRuntimeProvider`, see
 * `packages/sandbox/README.md`). Every call carries an agent-to-web token and is checked by
 * `sandboxRpcHandler` before a sandbox is opened; never serve this route without that check.
 *
 * In production it answers 404 unless `BETTER_AUTH_SECRET` is set and real sandboxes are
 * configured (Vercel OIDC, `LOCUS_SANDBOX_TOKEN`... or Daytona), so it never fronts the fake or the
 * unconfigured provider. Outside production the fake serves it, for local runs of the agent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s is the most every Vercel plan allows with Fluid compute (Hobby's cap). The handler cuts
// each command at `MAX_CALL_COMMAND_MS` to end inside it; the caller resumes a longer install.
export const maxDuration = 300;

const notFound = () => new Response("Not Found", { status: 404 });

/** Real sandboxes are configured; a provider setting that names none counts as not. */
function realSandboxes(): boolean {
  try {
    return sandboxProviderFromEnv(process.env) !== null;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !configured()) return notFound();
  if (process.env.NODE_ENV === "production" && !realSandboxes()) return notFound();
  return sandboxRpcHandler({ db: locus().db, provider: siteRuntimes(), authSecret: secret })(
    request,
  );
}

// Any other method gets the same bare 404, not Next's 405.
export { notFound as GET, notFound as PUT, notFound as PATCH, notFound as DELETE };
