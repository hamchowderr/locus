import { randomUUID } from "node:crypto";
import { authorizeUrl } from "@locus/connect";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl, connectDeps, ghlMode, STATE_COOKIE } from "@/lib/connect";
import { currentSession, NotConfigured } from "@/lib/locus";

/** Sends an owner or admin to GHL to approve Locus on their agency. */
export async function GET() {
  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    const { ghl } = connectDeps();
    const state = randomUUID();
    (await cookies()).set(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/connect/crm",
      maxAge: 600,
    });
    const target =
      ghlMode() === "stub"
        ? `${baseUrl()}/api/connect/crm/stub-authorize?state=${encodeURIComponent(state)}`
        : authorizeUrl(ghl, state);
    return NextResponse.redirect(target);
  } catch (error) {
    if (error instanceof NotConfigured) {
      return NextResponse.redirect(new URL("/connect?error=not-configured", baseUrl()));
    }
    throw error;
  }
}
