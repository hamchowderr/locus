import { ClientAccessDenied } from "@locus/auth";
import { ConnectError, connectVercel } from "@locus/connect";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/connect";
import { VERCEL_STATE_COOKIE, vercelDeps } from "@/lib/hosts";
import { currentSession, NotConfigured, sessionContext } from "@/lib/locus";

const back = (query: string) => NextResponse.redirect(new URL(`/connect?${query}`, baseUrl()));

/**
 * Vercel sends the installer back here with a `code`, `configurationId`, `teamId` and our
 * `state`. Installs that did not start from Locus carry no state and are refused: the agency
 * connects from the Connect page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(VERCEL_STATE_COOKIE)?.value;
  jar.delete({ name: VERCEL_STATE_COOKIE, path: "/api/connect/vercel" });
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!expected || !state || state !== expected || !code) return back("error=vercel-state");

  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    const result = await connectVercel(vercelDeps(), sessionContext(current), { code });
    return back(`vercel=${encodeURIComponent(result.accountName)}`);
  } catch (error) {
    if (error instanceof ConnectError || error instanceof ClientAccessDenied) {
      return back(`error=${encodeURIComponent(error.message)}`);
    }
    if (error instanceof NotConfigured) return back("error=vercel-not-configured");
    throw error;
  }
}
