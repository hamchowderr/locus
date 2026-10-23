import type { AuthorizedClient } from "@locus/auth";
import { type ListedSite, listSites } from "@locus/connect";
import { Funnel, Globe } from "lucide-react";
import Link from "next/link";
import { SITE_STATUS } from "@/app/(app)/sites/[siteId]/site";
import { RefreshWhenShown } from "@/components/refresh-when-shown";
import { Badge } from "@/components/ui/badge";
import { locus, NotConfigured } from "@/lib/locus";
import { type SiteSummary, siteSummaries } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";

/**
 * The chat's Library tab: what this sub-account's threads made, newest first, each opening its
 * workspace. Read on the server when the chat page loads; the Library page has the rest
 * (folders, linking a Vercel project).
 */
export async function LibraryTab({ client }: { client: AuthorizedClient }) {
  const sites = await listSites(locus().db, client);
  // The deps are built inside the promise: an environment without the site builder's settings
  // throws NotConfigured while building them, and that must not take the chat page down.
  const names = await Promise.resolve()
    .then(() =>
      siteSummaries(
        siteBuilderDeps(),
        client,
        sites.map((s) => s.id),
      ),
    )
    .catch((e) => {
      if (e instanceof NotConfigured) return new Map<string, SiteSummary>();
      console.error("Library tab: reading site names failed", e);
      return new Map<string, SiteSummary>();
    });
  const sorted = [...sites].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <RefreshWhenShown className="flex flex-col gap-3">
      {sorted.length === 0 ? (
        <p className="px-2 text-pretty text-xs text-muted-foreground">
          What this sub-account&apos;s threads make shows up here. Ask in the chat for a site or a
          funnel, and a thread builds it.
        </p>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((s) => (
            <li key={s.id}>
              <LibraryRow site={s} summary={names.get(s.id)} />
            </li>
          ))}
        </ul>
      )}
      <Link href="/sites" className="px-2 text-xs text-muted-foreground underline">
        Open the full Library
      </Link>
    </RefreshWhenShown>
  );
}

function LibraryRow({ site, summary }: { site: ListedSite; summary: SiteSummary | undefined }) {
  const Icon = summary?.kind === "funnel" ? Funnel : Globe;
  const name = summary?.name ?? site.hostProjectId ?? "Untitled site";
  const address = site.customDomain ?? site.deployUrl?.replace(/^https?:\/\//, "") ?? null;
  return (
    <Link
      href={`/sites/${encodeURIComponent(site.id)}`}
      className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {address && <span className="block truncate text-xs text-muted-foreground">{address}</span>}
      </span>
      <Badge variant={site.status === "deployed" ? "default" : "secondary"}>
        {SITE_STATUS[site.status]}
      </Badge>
    </Link>
  );
}
