import { NextResponse } from "next/server";
import { ghlMode, stubAuthorizeTarget } from "@/lib/connect";

/** GHL_MODE=stub only: stands in for GHL's approval page and approves at once. */
export async function GET(request: Request) {
  if (ghlMode() !== "stub") return new NextResponse(null, { status: 404 });
  const state = new URL(request.url).searchParams.get("state") ?? "";
  return NextResponse.redirect(stubAuthorizeTarget(state));
}
