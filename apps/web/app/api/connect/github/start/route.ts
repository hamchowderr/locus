import { randomUUID } from "node:crypto";
import { githubInstallUrl } from "@locus/connect";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseUrl, serviceMode } from "@/lib/connect";
import { GITHUB_STATE_COOKIE, githubDeps } from "@/lib/hosts";
import { currentSession, NotConfigured } from "@/lib/locus";

/** Sends an owner or admin to install the Locus GitHub App on their organisation. */
export async function GET() {
  const current = await currentSession();
  if (!current) return NextResponse.redirect(new URL("/sign-in?next=%2Fconnect", baseUrl()));
  try {
    const { github } = githubDeps();
    const state = randomUUID();
    (await cookies()).set(GITHUB_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/connect/github",
      maxAge: 900,
    });
    const target =
      serviceMode("GITHUB_MODE") === "stub"
        ? `${baseUrl()}/api/connect/github/stub-authorize?state=${encodeURIComponent(state)}`
        : githubInstallUrl(github, state);
    return NextResponse.redirect(target);
  } catch (error) {
    if (error instanceof NotConfigured) {
      return NextResponse.redirect(new URL("/connect?error=github-not-configured", baseUrl()));
    }
    throw error;
  }
}
