"use server";

import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import {
  bookmarkSiteVersion,
  restoreSiteVersion,
  SiteInputError,
  type SitePreview,
  startSitePreview,
} from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

const versionsPath = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/versions`;

/** A refusal the person can act on, as text; anything else is a bug and is thrown. */
function refusal(error: unknown): string | null {
  if (error instanceof SiteInputError) return error.message;
  if (error instanceof ClientAccessDenied) {
    return "You don't have access to that site. Choose its client on the Clients page.";
  }
  if (error instanceof NotConfigured) return "Client databases aren't set up here yet.";
  return null;
}

async function signedIn(next: string) {
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  const ctx = sessionContext(current);
  return { ctx, client: await resolveActiveClient(locus().db, ctx) };
}

async function versionAction(
  form: FormData,
  change: (input: {
    ctx: Awaited<ReturnType<typeof signedIn>>["ctx"];
    client: Awaited<ReturnType<typeof signedIn>>["client"];
    siteId: string;
    number: number;
  }) => Promise<string>,
) {
  const siteId = text(form, "siteId");
  const path = versionsPath(siteId);
  let done: string;
  try {
    const { ctx, client } = await signedIn(path);
    done = await change({ ctx, client, siteId, number: Number(text(form, "number")) });
  } catch (error) {
    const message = refusal(error);
    if (message) redirect(`${path}?error=${encodeURIComponent(message)}`);
    throw error;
  }
  revalidatePath(path);
  redirect(`${path}?${done}`);
}

/** Bookmarks one of the site's versions, or takes the bookmark off. */
export async function bookmarkVersion(form: FormData) {
  await versionAction(form, async ({ client, siteId, number }) => {
    const bookmarked = text(form, "bookmarked") === "yes";
    await bookmarkSiteVersion(siteBuilderDeps(), client, siteId, { number, bookmarked });
    return bookmarked ? `bookmarked=${number}` : "unbookmarked=1";
  });
}

/** Makes a saved version the site's current files again, as a new version. */
export async function restoreVersion(form: FormData) {
  await versionAction(form, async ({ ctx, client, siteId, number }) => {
    const { restored, version } = await restoreSiteVersion(
      siteBuilderDeps(),
      ctx,
      client,
      siteId,
      number,
    );
    return `restored=${restored}&now=${version.number}`;
  });
}

/**
 * Starts the site's preview (its current files, or one saved version's) for the preview page.
 * Returns what the page shows, or the problem in words.
 */
export async function previewSite(
  siteId: string,
  version: number | null,
): Promise<SitePreview | { problem: string }> {
  try {
    const { ctx, client } = await signedIn(`/sites/${encodeURIComponent(siteId)}/preview`);
    return await startSitePreview(siteBuilderDeps(), ctx, client, siteId, { version });
  } catch (error) {
    unstable_rethrow(error);
    const message = refusal(error);
    if (message) return { problem: message };
    console.error("Starting a site preview failed", error);
    return { problem: "The preview didn't start. Try again in a moment." };
  }
}
