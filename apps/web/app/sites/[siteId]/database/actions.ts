"use server";

import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { ConnectError, restoreSiteBackend, undoSiteBackendRestore } from "@locus/connect";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { siteRestoreDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

const databasePath = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/database`;

/** A refusal the person can act on, as text; anything else is a bug and is thrown. */
function refusal(error: unknown): string | null {
  if (error instanceof ConnectError) return error.message;
  if (error instanceof ClientAccessDenied) {
    return "Only the agency's owners and admins can restore a site's database.";
  }
  if (error instanceof NotConfigured) return "Site databases aren't set up here yet.";
  return null;
}

async function databaseAction(
  form: FormData,
  change: (input: {
    ctx: ReturnType<typeof sessionContext>;
    client: Awaited<ReturnType<typeof resolveActiveClient>>;
    siteId: string;
  }) => Promise<string>,
) {
  const siteId = text(form, "siteId");
  const path = databasePath(siteId);
  let done: string;
  try {
    const current = await currentSession();
    if (!current) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
    const ctx = sessionContext(current);
    const client = await resolveActiveClient(locus().db, ctx);
    done = await change({ ctx, client, siteId });
  } catch (error) {
    const message = refusal(error);
    if (message) redirect(`${path}?error=${encodeURIComponent(message)}`);
    throw error;
  }
  revalidatePath(path);
  redirect(`${path}?${done}`);
}

/** Restores the site's database to a moment the page offered, after the person confirmed. */
export async function restoreDatabase(form: FormData) {
  await databaseAction(form, async ({ ctx, client, siteId }) => {
    if (text(form, "confirm") !== "yes") {
      throw new ConnectError("Tick the box to confirm the restore.");
    }
    const to = new Date(Number(text(form, "to")));
    const { redeployed } = await restoreSiteBackend(siteRestoreDeps(), ctx, client, {
      siteId,
      to,
    });
    return `restored=${redeployed ? "live" : "saved"}`;
  });
}

/** Puts back the database the site had before its last restore. */
export async function undoDatabaseRestore(form: FormData) {
  await databaseAction(form, async ({ ctx, client, siteId }) => {
    if (text(form, "confirm") !== "yes") {
      throw new ConnectError("Tick the box to confirm undoing the restore.");
    }
    const { redeployed } = await undoSiteBackendRestore(siteRestoreDeps(), ctx, client, {
      siteId,
    });
    return `undone=${redeployed ? "live" : "saved"}`;
  });
}
