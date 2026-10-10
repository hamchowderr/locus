import { ClientAccessDenied } from "@locus/auth";
import { ConnectError, connectGithub } from "@locus/connect";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/connect";
import { GITHUB_STATE_COOKIE, githubDeps } from "@/lib/hosts";
import { currentSession, NotConfigured, sessionContext } from "@/lib/locus";

const back = (query: string) => NextResponse.redirect(new URL(`/connect?${query}`, baseUrl()));

/**
 * GitHub sends the installer back here with a `code` (and usually `installation_id`). The
 * state must match ours; the installation id is only a hint, checked against what the
 * installing user can actually access.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(GITHUB_STATE_COOKIE)?.value;
  jar.delete({ name: GITHUB_STATE_COOKIE, path: "/api/connect/github" });
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!expected || !state || state !== expected || !code) return back("error=github-state");

  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    const result = await connectGithub(githubDeps(), sessionContext(current), {
      code,
      installationId: url.searchParams.get("installation_id"),
    });
    return back(`github=${encodeURIComponent(result.accountLogin)}`);
  } catch (error) {
    if (error instanceof ConnectError || error instanceof ClientAccessDenied) {
      return back(`error=${encodeURIComponent(error.message)}`);
    }
    if (error instanceof NotConfigured) return back("error=github-not-configured");
    throw error;
  }
}
