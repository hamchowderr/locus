import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Notice, Page } from "@/app/ui";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { type SiteHistory, siteHistory, VERSIONS_SHOWN } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { bookmarkVersion, restoreVersion } from "../actions";

const SOURCE: Record<SiteHistory["versions"][number]["source"], string> = {
  template: "From the template",
  agent: "Site builder",
  restore: "Restore",
  edit: "Edit",
  copy: "Copy",
};

const when = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export default async function Versions({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{
    error?: string;
    bookmarked?: string;
    unbookmarked?: string;
    restored?: string;
    now?: string;
  }>;
}) {
  const { siteId } = await params;
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(`/sites/${siteId}/versions`)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, bookmarked, unbookmarked, restored, now } = await searchParams;
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const history = await siteHistory(siteBuilderDeps(), client, siteId).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!history) notFound();
  const number = (value: string | undefined) => (value && /^\d{1,6}$/.test(value) ? value : null);
  const latest = history.versions[0]?.number;

  return (
    <Page title="Versions">
      {error && <Notice tone="error">{error}</Notice>}
      {number(restored) && (
        <Notice tone="info">
          Version {number(restored)} is back, saved as version {number(now)}. Publish it when you're
          happy with it.
        </Notice>
      )}
      {number(bookmarked) && <Notice tone="info">Version {number(bookmarked)} bookmarked.</Notice>}
      {unbookmarked && <Notice tone="info">Bookmark removed.</Notice>}
      {history.refusal && <Notice tone="info">{history.refusal}</Notice>}
      {history.unsaved && !history.refusal && (
        <Notice tone="info">
          The site builder has changes it hasn't saved yet. Restoring keeps them as a version first.
        </Notice>
      )}
      <p className="text-sm text-neutral-600">
        Every save is kept. Restoring an older version saves it again as the newest, so you can
        always go back.
      </p>
      {history.versions.length === 0 && (
        <p className="text-neutral-600">This site has no saved versions yet.</p>
      )}
      <ol className="space-y-3">
        {history.versions.map((v) => (
          <li key={v.id} className="space-y-2 rounded-md border border-neutral-200 p-3">
            <p className="text-sm">
              <strong>Version {v.number}</strong>
              {v.bookmarked && " · Bookmarked"}
              {v.number === latest && " · Current"}
            </p>
            <p>{v.message}</p>
            <p className="text-xs text-neutral-500">
              {SOURCE[v.source]} · {when.format(v.createdAt)} UTC
              {v.commitSha && ` · Published as ${v.commitSha.slice(0, 7)}`}
            </p>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Link href={`/sites/${siteId}?version=${v.number}`} className="underline">
                Preview
              </Link>
              {!history.refusal && (
                <form action={bookmarkVersion}>
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="number" value={v.number} />
                  <input type="hidden" name="bookmarked" value={v.bookmarked ? "no" : "yes"} />
                  <button type="submit" className="underline">
                    {v.bookmarked ? "Remove bookmark" : "Bookmark"}
                  </button>
                </form>
              )}
              {v.number !== latest && !history.refusal && (
                <form action={restoreVersion}>
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="number" value={v.number} />
                  <button type="submit" className="underline">
                    Restore this version
                  </button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ol>
      {history.more > 0 && (
        <p className="text-sm text-neutral-600">
          Showing the newest {VERSIONS_SHOWN}. {history.more} older{" "}
          {history.more === 1 ? "version is" : "versions are"} kept but not listed.
        </p>
      )}
    </Page>
  );
}
