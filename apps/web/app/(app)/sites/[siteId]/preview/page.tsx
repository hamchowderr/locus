import { redirect } from "next/navigation";

/** The preview moved onto the site's Build tab; old links (and a version's preview) land there. */
export default async function Preview({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { siteId } = await params;
  const { version } = await searchParams;
  const query = version && /^\d{1,6}$/.test(version) ? `?version=${version}` : "";
  redirect(`/sites/${encodeURIComponent(siteId)}${query}`);
}
