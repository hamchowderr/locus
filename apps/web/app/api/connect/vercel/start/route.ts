import { randomUUID } from "node:crypto";
import { vercelInstallUrl } from "@locus/connect";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl, serviceMode } from "@/lib/connect";
import { VERCEL_STATE_COOKIE, vercelDeps } from "@/lib/hosts";
import { currentSession, NotConfigured } from "@/lib/locus";

/** Sends an owner or admin to install the Locus Vercel Integration on their team. */
export async function GET() {
  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    const { vercel } = vercelDeps();
    const state = randomUUID();
    (await cookies()).set(VERCEL_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/connect/vercel",
      maxAge: 900,
    });
    const target =
      serviceMode("VERCEL_MODE") === "stub"
        ? `${baseUrl()}/api/connect/vercel/stub-authorize?state=${encodeURIComponent(state)}`
        : vercelInstallUrl(vercel, state);
    return NextResponse.redirect(target);
  } catch (error) {
    if (error instanceof NotConfigured) {
      return NextResponse.redirect(new URL("/connect?error=vercel-not-configured", baseUrl()));
    }
    throw error;
  }
}
