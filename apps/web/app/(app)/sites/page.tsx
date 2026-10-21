import { ClientAccessDenied, requireAgencyManager, resolveActiveClient } from "@locus/auth";
import {
  ConnectError,
  type HostProject,
  type ListedSite,
  listHostProjects,
  listSites,
} from "@locus/connect";
import { Globe, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { linkSiteProject } from "@/app/actions";
import { Notice, Page, Button as SubmitButton } from "@/app/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { siteDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { siteNames } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { SITE_STATUS } from "./[siteId]/site";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * The sub-account's sites, as cards grouped by folder. Opening one goes to its workspace (the
 * preview with its chat beside it); everything else about a site is on its Settings tab.
 */
export default async function Sites({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string; copied?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, deleted, copied } = await searchParams;
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
  const sites = await listSites(db, client);
  const builderOn = client.location.siteBuilder;
  // Names live in the brief, in the sub-account's own database.
  const names = await siteNames(
    siteBuilderDeps(),
    client,
    sites.map((s) => s.id),
  ).catch((e) => {
    if (e instanceof NotConfigured) return new Map<string, string>();
    console.error("Sites page: reading site names failed", e);
    return null;
  });
  // Projects on the agency's Vercel team that aren't a site yet, for owners and admins.
  let linkable: HostProject[] = [];
  let projectProblem: string | null = null;
  if (manager) {
    try {
      const linked = new Set(sites.map((s) => s.hostProjectId));
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
    names?.get(s.id) ??
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
      title="Sites"
      width="wide"
      description="Open a site to build it: the preview with its own chat beside it."
      actions={
        builderOn && (
          <Button asChild>
            <Link href="/sites/new">
              <Plus data-icon="inline-start" />
              New site
            </Link>
          </Button>
        )
      }
    >
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
          <Globe className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">No sites yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {builderOn
              ? "Create one and shape it in its chat, with the preview beside you."
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
              <li key={s.id}>
                <SiteCard site={s} name={nameOf(s)} />
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
      className="group flex h-full flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/30"
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
