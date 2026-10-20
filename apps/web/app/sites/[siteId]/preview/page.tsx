import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { SITE_BUILDER_MODE_ID } from "@locus/builder";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EditablePreview } from "@/components/visual-edits/editable-preview";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { clientSite, siteNames } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { previewSite } from "../actions";

/** Starting a preview can install the site's packages first. */
export const maxDuration = 300;

export default async function Preview({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { siteId } = await params;
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(`/sites/${siteId}/preview`)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const found = await clientSite(locus().db, client, siteId).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  if (!found) notFound();
  const { version: asked } = await searchParams;
  const version = asked && /^\d{1,6}$/.test(asked) ? Number(asked) : null;
  const name = (await siteNames(siteBuilderDeps(), client, [siteId])).get(siteId) ?? "Site";

  return (
    <main className="mx-auto flex h-dvh max-w-6xl flex-col px-6 py-6">
      <p className="text-sm">
        <Link href="/sites" className="underline">
          Sites
        </Link>
        {" · "}
        <Link href={`/sites/${siteId}/versions`} className="underline">
          Versions
        </Link>
        {" · "}
        Preview of <strong>{name}</strong>
        {version ? `, version ${version}` : ""}
      </p>
      <EditablePreview
        siteId={siteId}
        chatMode={SITE_BUILDER_MODE_ID}
        className="mt-4 min-h-0 flex-1"
        version={version}
        start={previewSite.bind(null, siteId, version)}
      />
    </main>
  );
}
