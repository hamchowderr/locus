import { NextResponse } from "next/server";
import { serviceMode } from "@/lib/connect";
import { stubGithubCallback } from "@/lib/hosts";

/** GITHUB_MODE=stub only: stands in for GitHub's install page and installs at once. */
export async function GET(request: Request) {
  if (serviceMode("GITHUB_MODE") !== "stub") return new NextResponse(null, { status: 404 });
  const state = new URL(request.url).searchParams.get("state") ?? "";
  return NextResponse.redirect(stubGithubCallback(state));
}
