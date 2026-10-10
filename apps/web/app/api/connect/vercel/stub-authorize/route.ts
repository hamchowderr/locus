import { NextResponse } from "next/server";
import { serviceMode } from "@/lib/connect";
import { stubVercelCallback } from "@/lib/hosts";

/** VERCEL_MODE=stub only: stands in for Vercel's install page and installs at once. */
export async function GET(request: Request) {
  if (serviceMode("VERCEL_MODE") !== "stub") return new NextResponse(null, { status: 404 });
  const state = new URL(request.url).searchParams.get("state") ?? "";
  return NextResponse.redirect(stubVercelCallback(state));
}
