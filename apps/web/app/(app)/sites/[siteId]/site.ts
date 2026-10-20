import { ClientAccessDenied, requireAgencyManager, resolveActiveClient } from "@locus/auth";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { buildRefusal, siteNames, siteOfClient } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";

/** What a site's status says, in words. */
export const SITE_STATUS: Record<"draft" | "pushed" | "deployed" | "failed", string> = {
  draft: "Draft",
  pushed: "Published",
  deployed: "Live",
  failed: "Publish failed",
};

/**
 * One of the active sub-account's sites, for its pages (the layout and each tab share one
 * lookup per request). Sends the visitor to sign in or choose a sub-account, and 404s a site
 * that isn't this sub-account's. `next` is where signing in comes back to.
 */
export const siteForPage = cache(async (siteId: string, next: string) => {
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const ctx = sessionContext(current);
  const db = locus().db;
  const client = await resolveActiveClient(db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const row = await siteOfClient(db, client, siteId).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!row) notFound();
  // A site started in Locus has a brief (its name) and versions; a linked Vercel project
  // has neither, so it can't be built here.
  // A failed read is not a missing brief: the pages say Locus couldn't read it instead.
  const names = await siteNames(siteBuilderDeps(), client, [siteId]).catch((e) => {
    console.error("Reading a site's name failed", e);
    return null;
  });
  const name = names?.get(siteId);
  const [refusal, manager] = await Promise.all([
    buildRefusal(db, client, siteId),
    requireAgencyManager(db, ctx).then(
      () => true,
      (e) => {
        if (e instanceof ClientAccessDenied) return false;
        throw e;
      },
    ),
  ]);
  return {
    ctx,
    client,
    site: row,
    /** The site's own name, or null for a linked project that wasn't started in Locus. */
    name: name ?? null,
    /** The sub-account's database didn't answer, so `name` is unknown rather than missing. */
    unread: names === null,
    /** Why this member can't build the site (the builder is off, or they only view it). */
    refusal,
    /** An owner or admin, who publishes, connects domains and deletes. */
    manager,
  };
});
