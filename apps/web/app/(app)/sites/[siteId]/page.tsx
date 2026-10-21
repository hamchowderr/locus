import { SITE_BUILDER_MODE_ID } from "@locus/builder";
import Link from "next/link";
import { Notice } from "@/app/ui";
import { SiteWorkspace } from "@/components/site-workspace/site-workspace";
import { VersionPicker } from "@/components/site-workspace/version-picker";
import { Button } from "@/components/ui/button";
import { chatKitEnabled } from "@/lib/chat-kit";
import { siteHistory } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { previewSite, restoreVersion } from "./actions";
import { siteForPage } from "./site";

/** Starting a preview can install the site's packages first. */
export const maxDuration = 300;

/**
 * A site's Preview tab: its live preview, with the site's own chat beside it. The chat always
 * runs the site builder on this site, so there is no mode to pick. The preview's version picker
 * shows any saved version, and restores it from here.
 */
export default async function BuildSite({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{
    version?: string;
    error?: string;
    created?: string;
    published?: string;
    deploys?: string;
    copied?: string;
    restored?: string;
    now?: string;
  }>;
}) {
  const { siteId } = await params;
  const { client, site, name, unread, refusal } = await siteForPage(siteId, `/sites/${siteId}`);
  const query = await searchParams;
  const { version: asked, error, created, published, deploys, copied } = query;
  const number = (value: string | undefined) =>
    value && /^\d{1,6}$/.test(value) ? Number(value) : null;
  const version = number(asked);
  const restored = number(query.restored);

  const notices = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {created && (
        <Notice tone="info">Site created from its template. Tell the chat what to change.</Notice>
      )}
      {copied && <Notice tone="info">This is the copy, a new draft of its own.</Notice>}
      {restored !== null && (
        <Notice tone="info">
          Version {restored} is back, saved as version {number(query.now) ?? "the newest"}. Publish
          it when you're happy with it.
        </Notice>
      )}
      {published && /^\d{1,6}$/.test(published) && (
        <Notice tone="info">
          Version {published} sent to {site.repoFullName ?? "GitHub"}.
          {deploys ? " Vercel deploys it in a minute or two." : ""}
        </Notice>
      )}
    </>
  );

  if (unread) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
        {notices}
        <Notice tone="error">
          Locus couldn't read this site's details just now. Reload to try again.
        </Notice>
      </div>
    );
  }
  if (name === null) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
        {notices}
        <p className="text-neutral-600">
          This site's Vercel project is linked to the sub-account, but the site wasn't made in
          Locus, so it can't be built here. Its domain is on the Settings tab.
        </p>
      </div>
    );
  }

  // The version picker lists the saved versions; without them the preview still works.
  const history = await siteHistory(siteBuilderDeps(), client, siteId).catch((e) => {
    console.error("Reading a site's versions failed", e);
    return null;
  });
  const shown = version === null ? null : history?.versions.find((v) => v.number === version);
  const home = `/sites/${encodeURIComponent(siteId)}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(error || created || copied || published || restored !== null) && (
        <div className="space-y-2 px-4 pt-3">{notices}</div>
      )}
      <SiteWorkspace
        siteId={siteId}
        className="min-h-0 flex-1"
        version={version}
        start={previewSite.bind(null, siteId, version)}
        leading={
          history && (
            <VersionPicker
              siteId={siteId}
              shown={version}
              versions={history.versions.map((v) => ({
                number: v.number,
                message: v.message,
                createdAt: v.createdAt.toISOString(),
                bookmarked: v.bookmarked,
              }))}
            />
          )
        }
        notice={
          version !== null && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
              <span
                className="min-w-0 flex-1 truncate"
                title="The site builder keeps working on the latest files until you restore this."
              >
                Showing version {version}
                {shown ? `: ${shown.message}` : ""}
              </span>
              {history?.unsaved && (
                <span className="basis-full text-muted-foreground text-xs sm:order-last">
                  The site builder has changes it hasn't saved yet. Restoring keeps them as a
                  version first.
                </span>
              )}
              <Button asChild size="sm" variant="ghost">
                <Link href={home}>Back to latest</Link>
              </Button>
              {!refusal && !history?.refusal && version !== history?.versions[0]?.number && (
                <form action={restoreVersion}>
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="number" value={version} />
                  <input type="hidden" name="returnTo" value={home} />
                  <Button type="submit" size="sm">
                    Restore this version
                  </Button>
                </form>
              )}
            </div>
          )
        }
        chat={
          chatKitEnabled()
            ? { mode: SITE_BUILDER_MODE_ID, refusal }
            : { off: "The chat isn't turned on here yet. It needs Locus's chat server." }
        }
      />
    </div>
  );
}
