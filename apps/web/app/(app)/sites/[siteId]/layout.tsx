import { ArrowLeft, ExternalLink, Rocket } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { publishSite } from "@/app/actions";
import { SiteTabs } from "@/components/site-workspace/site-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SITE_STATUS, siteForPage } from "./site";

/**
 * Every page of one site: its name, where it's live, its tabs (Preview, Versions, Database,
 * Settings) and Publish. Each page below still checks the site itself.
 */
export default async function SiteLayout({
  params,
  children,
}: {
  params: Promise<{ siteId: string }>;
  children: ReactNode;
}) {
  const { siteId } = await params;
  const { site, name, refusal, manager } = await siteForPage(siteId, `/sites/${siteId}`);
  const live = site.customDomain ?? site.deployUrl?.replace(/^https?:\/\//, "") ?? null;
  // Publishing needs a repository; until it has one, Settings sets it up.
  const canPublish = manager && !refusal && name !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <Link
          href="/sites"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Library
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate font-semibold">
            {name ?? site.hostProjectId ?? "Untitled site"}
          </h1>
          <Badge variant={site.status === "deployed" ? "default" : "secondary"}>
            {SITE_STATUS[site.status]}
          </Badge>
          {live && (
            <a
              href={`https://${live}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 truncate text-sm text-muted-foreground hover:text-foreground"
            >
              {live}
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        <SiteTabs siteId={siteId} />
        <div className="ml-auto">
          {canPublish &&
            (site.repoFullName ? (
              <form action={publishSite}>
                <input type="hidden" name="siteId" value={siteId} />
                <input type="hidden" name="returnTo" value={`/sites/${siteId}`} />
                {site.hostProjectId && <input type="hidden" name="deploys" value="yes" />}
                <Button type="submit" size="sm">
                  <Rocket data-icon="inline-start" />
                  Publish
                </Button>
              </form>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={`/sites/${siteId}/settings#publishing`}>
                  <Rocket data-icon="inline-start" />
                  Set up publishing
                </Link>
              </Button>
            ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
