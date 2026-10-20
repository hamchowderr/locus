"use server";

import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { cookies } from "next/headers";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { ACTIVE_SITE_COOKIE, chooseActiveSite } from "@/lib/site-builder";

/**
 * Makes `siteId` the site the chat's site builder works on, as "Build this site" on the Sites
 * page does, so a request about a selected item in its preview changes this site. The site
 * must be the session's active client's.
 */
export async function chooseSiteForChat(
  siteId: string,
): Promise<{ ok: true } | { problem: string }> {
  const current = await currentSession();
  if (!current) return { problem: "Sign in again, then try again." };
  const ctx = sessionContext(current);
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    const chosen = await chooseActiveSite(locus().db, ctx, client, siteId);
    (await cookies()).set(ACTIVE_SITE_COOKIE, chosen, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof ClientAccessDenied) return { problem: "You can't build this site." };
    throw error;
  }
}
