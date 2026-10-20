import { SITE_BUILDER_MODE_ID } from "@locus/builder";
import { Notice } from "@/app/ui";
import { SiteWorkspace } from "@/components/site-workspace/site-workspace";
import { chatKitEnabled } from "@/lib/chat-kit";
import { previewSite } from "./actions";
import { siteForPage } from "./site";

/** Starting a preview can install the site's packages first. */
export const maxDuration = 300;

/**
 * A site's Build tab: its live preview, with the site's own chat beside it. The chat always
 * runs the site builder on this site, so there is no mode to pick.
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
  }>;
}) {
  const { siteId } = await params;
  const { site, name, refusal } = await siteForPage(siteId, `/sites/${siteId}`);
  const { version: asked, error, created, published, deploys, copied } = await searchParams;
  const version = asked && /^\d{1,6}$/.test(asked) ? Number(asked) : null;

  const notices = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {created && (
        <Notice tone="info">Site created from its template. Tell the chat what to change.</Notice>
      )}
      {copied && <Notice tone="info">This is the copy, a new draft of its own.</Notice>}
      {published && /^\d{1,6}$/.test(published) && (
        <Notice tone="info">
          Version {published} sent to {site.repoFullName ?? "GitHub"}.
          {deploys ? " Vercel deploys it in a minute or two." : ""}
        </Notice>
      )}
    </>
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(error || created || copied || published) && (
        <div className="space-y-2 px-4 pt-3">{notices}</div>
      )}
      <SiteWorkspace
        siteId={siteId}
        className="min-h-0 flex-1"
        version={version}
        start={previewSite.bind(null, siteId, version)}
        chat={
          chatKitEnabled()
            ? { mode: SITE_BUILDER_MODE_ID, refusal }
            : { off: "The chat isn't turned on here yet. It needs Locus's chat server." }
        }
      />
    </div>
  );
}
