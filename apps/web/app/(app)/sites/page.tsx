import { ClientAccessDenied, requireAgencyManager, resolveActiveClient } from "@locus/auth";
import {
  ConnectError,
  type HostProject,
  type ListedSite,
  listHostProjects,
  listSites,
} from "@locus/connect";
import { Funnel, Globe, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { linkSiteProject } from "@/app/actions";
import { Notice, Page, Button as SubmitButton } from "@/app/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { siteDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { type SiteSummary, siteSummaries } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { SITE_STATUS } from "./[siteId]/site";
import { MadeIn } from "./made-in";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** The Library's tabs: what a thread can make, by the site kinds each holds. */
const TABS = [
  { id: "sites", name: "Sites", empty: "No sites yet", icon: Globe },
  { id: "funnels", name: "Funnels", empty: "No funnels yet", icon: Funnel },
] as const;
type Tab = (typeof TABS)[number]["id"];

const tabOf = (kind: SiteSummary["kind"] | undefined): Tab =>
  kind === "funnel" ? "funnels" : "sites";

/**
 * The Library: everything the sub-account's threads made, as cards on a tab per kind, grouped
 * by folder. Each card says which thread made it; opening one goes to its workspace (the
 * preview with its chat beside it); everything else about a site is on its Settings tab.
 */
export default async function Sites({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string; copied?: string; tab?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, deleted, copied, tab: askedTab } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === askedTab) ? (askedTab as Tab) : "sites";
  const ctx = sessionContext(current);
  const db = locus().db;
  const client = await resolveActiveClient(db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const manager = await requireAgencyManager(db, ctx).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const allSites = await listSites(db, client);
  const builderOn = client.location.siteBuilder;
  // Names and kinds live in the brief, in the sub-account's own database.
  const names = await siteSummaries(
    siteBuilderDeps(),
    client,
    allSites.map((s) => s.id),
  ).catch((e) => {
    if (e instanceof NotConfigured) return new Map<string, SiteSummary>();
    console.error("Library: reading site names failed", e);
    return null;
  });
  // A site with no brief (linked from Vercel, or unreadable) is listed with the sites.
  const sites = allSites.filter((s) => tabOf(names?.get(s.id)?.kind) === tab);
  const counts = new Map<Tab, number>();
  for (const s of allSites) {
    const t = tabOf(names?.get(s.id)?.kind);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const shown = TABS.find((t) => t.id === tab) ?? TABS[0];
  // Projects on the agency's Vercel team that aren't a site yet, for owners and admins.
  let linkable: HostProject[] = [];
  let projectProblem: string | null = null;
  if (manager) {
    try {
      const linked = new Set(allSites.map((s) => s.hostProjectId));
      linkable = (await listHostProjects(siteDeps(), ctx)).projects.filter(
        (p) => !linked.has(p.id),
      );
    } catch (e) {
      if (e instanceof ConnectError) projectProblem = e.message;
      else if (!(e instanceof NotConfigured)) throw e;
    }
  }
  const projectNames = new Map(linkable.map((p) => [p.id, p.name]));
  const nameOf = (s: ListedSite) =>
    names?.get(s.id)?.name ??
    projectNames.get(s.hostProjectId ?? "") ??
    s.hostProjectId ??
    "Untitled site";

  // Filed sites first, by folder name, then the ones in no folder; each group newest first.
  const folders = [...new Set(sites.flatMap((s) => (s.folder ? [s.folder] : [])))].sort((a, b) =>
    a.localeCompare(b),
  );
  const groups = [...folders, null]
    .map((folder) => ({
      folder,
      sites: sites
        .filter((s) => s.folder === folder)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    }))
    .filter((g) => g.sites.length > 0);

  return (
    <Page
      title="Library"
      width="wide"
      description="Everything this sub-account's threads have made. Ask in Chat for a new site or funnel, and a thread builds it."
      actions={
        builderOn && (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/sites/new">
                <Plus data-icon="inline-start" />
                New site
              </Link>
            </Button>
            <Button asChild>
              <Link href="/chat">
                <MessageSquare data-icon="inline-start" />
                Ask in Chat
              </Link>
            </Button>
          </div>
        )
      }
    >
      <nav aria-label="Library" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.id === "sites" ? "/sites" : `/sites?tab=${t.id}`}
            aria-current={t.id === tab ? "page" : undefined}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
              t.id === tab
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="size-4" aria-hidden />
            {t.name}
            {(counts.get(t.id) ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">{counts.get(t.id)}</span>
            )}
          </Link>
        ))}
      </nav>
      {error && <Notice tone="error">{error}</Notice>}
      {deleted && <Notice tone="info">Site deleted.</Notice>}
      {copied === "elsewhere" && (
        <Notice tone="info">
          Site copied as a new draft. Switch to that sub-account to see it.
        </Notice>
      )}
      {!builderOn && (
        <Notice tone="info">
          The site builder is turned off for this sub-account, so its sites can't be created, built
          or published. {manager ? "Turn it on" : "An owner or admin can turn it on"} on the{" "}
          <Link href="/clients" className="underline">
            Sub-accounts
          </Link>{" "}
          page.
        </Notice>
      )}
      {names === null && (
        <Notice tone="error">
          Locus couldn't read this sub-account's site details just now. Reload to try again.
        </Notice>
      )}

      {sites.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <shown.icon className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">{shown.empty}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {builderOn
              ? "Ask for one in Chat: a thread builds it, and it shows here."
              : "Turn the site builder on to create one."}
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.folder ?? ""} className="space-y-3">
          {folders.length > 0 && (
            <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {group.folder ?? "No folder"}
            </h2>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.sites.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5">
                <SiteCard site={s} name={nameOf(s)} />
                <MadeIn siteId={s.id} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {manager && (linkable.length > 0 || projectProblem) && (
        <details className="rounded-lg border p-4 text-sm">
          <summary className="cursor-pointer font-medium">
            Already have a site on Vercel? Link it
          </summary>
          {projectProblem ? (
            <div className="pt-3">
              <Notice tone="error">
                {projectProblem}{" "}
                <Link href="/connect" className="underline">
                  Integrations
                </Link>
              </Notice>
            </div>
          ) : (
            <form action={linkSiteProject} className="space-y-2 pt-3">
              <label className="block">
                <span className="text-neutral-700">Vercel project</span>
                <select
                  name="projectId"
                  required
                  defaultValue=""
                  className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
                >
                  {/* Nothing chosen to start with, so no project gets linked by accident. */}
                  <option value="" disabled>
                    Choose a project
                  </option>
                  {linkable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-neutral-600">
                Linking lets you connect its domain here. A site not made in Locus can't be built in
                the chat.
              </p>
              <SubmitButton>Link project</SubmitButton>
            </form>
          )}
        </details>
      )}
    </Page>
  );
}

/** One site: its name, whether it's live and where, and when it was made. Opens its workspace. */
function SiteCard({ site, name }: { site: ListedSite; name: string }) {
  const address = site.customDomain ?? site.deployUrl?.replace(/^https?:\/\//, "") ?? null;
  return (
    <Link
      href={`/sites/${encodeURIComponent(site.id)}`}
      className="group flex flex-1 flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/30"
    >
      <div className="flex aspect-[16/9] items-center justify-center bg-muted text-3xl font-semibold text-muted-foreground transition-colors group-hover:bg-muted/70">
        {name.trim().charAt(0).toUpperCase() || "S"}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{name}</span>
          <Badge variant={site.status === "deployed" ? "default" : "secondary"}>
            {SITE_STATUS[site.status]}
          </Badge>
        </div>
        <span className="truncate text-sm text-muted-foreground">
          {address ?? `Made ${when.format(site.createdAt)}`}
        </span>
      </div>
    </Link>
  );
}
