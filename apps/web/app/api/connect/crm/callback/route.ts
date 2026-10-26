import { ClientAccessDenied } from "@locus/auth";
import { ConnectError, connectAgency, refusedQuery } from "@locus/connect";
import { GhlError } from "@locus/ghl";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl, connectDeps, STATE_COOKIE } from "@/lib/connect";
import { currentSession, sessionContext } from "@/lib/locus";
import { createAgencyFromGhl, integrationsReturn } from "@/lib/onboarding";

const back = async (query: string) =>
  NextResponse.redirect(new URL(await integrationsReturn(query), baseUrl()));

/** GHL sends the agency back here with a code. The state must match the one we set. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete({ name: STATE_COOKIE, path: "/api/connect/crm" });
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!expected || !state || state !== expected || !code) return await back("error=state");

  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    // Someone with no agency yet is setting one up: GoHighLevel comes first, and names it.
    const result = current.session.activeOrganizationId
      ? await connectAgency(connectDeps(), sessionContext(current), code)
      : await createAgencyFromGhl(code);
    return await back(`connected=${result.added}${refusedQuery(result)}`);
  } catch (error) {
    if (error instanceof ConnectError || error instanceof ClientAccessDenied) {
      return await back(`error=${encodeURIComponent(error.message)}`);
    }
    if (error instanceof GhlError) return await back("error=ghl");
    throw error;
  }
}
