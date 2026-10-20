import {
  ClientAccessDenied,
  listAccessibleClients,
  listSiteMembers,
  requireAgencyManager,
  resolveActiveClient,
  type SiteMember,
  viewOnlySites,
} from "@locus/auth";
import {
  ConnectError,
  type DomainStatus,
  type HostProject,
  type HostProjectList,
  type InstallationRepo,
  latestDeployment,
  listHostProjects,
  listInstallationRepos,
  listSites,
  MAX_FOLDER_LENGTH,
  type SiteDeployment,
  siteDomainStatus,
} from "@locus/connect";
import { SITE_KINDS, TEMPLATES } from "@locus/studio";
import Link from "next/link";
import { redirect } from "next/navigation";
import { publishDeps, siteDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import {
  activeSiteIdForSession,
  LEAD_TOTAL_DAYS,
  siteLeadTotals,
  siteNames,
} from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { deploymentLabel, linkableRepos, suggestedRepoName } from "@/lib/site-publish";
import {
  addSiteDomain,
  chooseSite,
  copySite,
  createSite,
  deleteSite,
  deleteSiteDomain,
  fileSite,
  giveSiteRepository,
  giveSiteVercelProject,
  linkSiteProject,
  publishSite,
  saveSiteAccess,
  unlinkSiteProject,
} from "../actions";
import { Button, Field, Notice, Page } from "../ui";

const STATE: Record<DomainStatus["state"], string> = {
  verify: "Waiting for Vercel to verify the domain. Add this record, then check again.",
  point: "Verified. Now point the domain at Vercel with this record, then check again.",
  live: "Live. The site is served on this domain.",
};

/** A Vercel, GitHub or configuration problem as text for the page, instead of failing it. */
async function softly<T>(
  run: () => Promise<T>,
  notConfigured = "Vercel isn't set up here yet.",
): Promise<T | { problem: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) return { problem: error.message };
    if (error instanceof NotConfigured) return { problem: notConfigured };
    // A network failure or a bad stored key shows as a notice, never a broken page.
    console.error("Sites page: a lookup failed", error);
    return { problem: "Locus couldn't load this just now. Reload to try again." };
  }
}
const KIND_LABELS: Record<(typeof SITE_KINDS)[number], string> = {
  website: "Website",
  "landing-page": "Landing page",
  funnel: "Funnel",
  app: "App",
  "internal-tool": "Internal tool",
};

const isProblem = (value: unknown): value is { problem: string } =>
  typeof value === "object" && value !== null && "problem" in value;

export default async function Sites({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    created?: string;
    chosen?: string;
    deleted?: string;
    published?: string;
    deploys?: string;
    copied?: string;
  }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const {
    error,
    created,
    chosen,
    deleted,
    published: publishedVersion,
    deploys,
    copied,
  } = await searchParams;
  const ctx = sessionContext(current);
  const client = await resolveActiveClient(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  // The same choice the chat's builder reads (`session.active_site_id`).
  const activeSite = await activeSiteIdForSession(locus().db, ctx, client);

  const manager = await requireAgencyManager(locus().db, ctx).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const sites = await listSites(locus().db, client);
  const builderOn = client.location.siteBuilder;
  const viewOnly = await viewOnlySites(locus().db, client);
  const canBuild = (siteId: string) => builderOn && !viewOnly.has(siteId);
  // Members restricted to some clients, this one included, and their access to each site.
  const siteMembers = manager
    ? await Promise.all(sites.map((s) => listSiteMembers(locus().db, ctx, client, s.id)))
    : sites.map((): SiteMember[] => []);
  // Where a copy can go: this client or any other this member works on.
  const clients = await listAccessibleClients(locus().db, ctx);
  // Filed sites first, by folder name, then the ones in no folder; each group oldest first.
  const folders = [...new Set(sites.flatMap((s) => (s.folder ? [s.folder] : [])))].sort((a, b) =>
    a.localeCompare(b),
  );
  const order = sites
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        (a.s.folder ? folders.indexOf(a.s.folder) : folders.length) -
          (b.s.folder ? folders.indexOf(b.s.folder) : folders.length) ||
        a.s.createdAt.getTime() - b.s.createdAt.getTime(),
    );
  const listing: HostProjectList | { problem: string } = manager
    ? await softly(() => listHostProjects(siteDeps(), ctx))
    : { projects: [], complete: false };
  const projects: HostProject[] | { problem: string } = isProblem(listing)
    ? listing
    : listing.projects;
  const names = new Map(isProblem(projects) ? [] : projects.map((p) => [p.id, p.name]));
  // Only known once every one of the team's projects was listed.
  const gone = (projectId: string | null) =>
    !isProblem(listing) && listing.complete && manager && !!projectId && !names.has(projectId);
  const linked = new Set(sites.map((s) => s.hostProjectId));
  const linkable = isProblem(projects) ? [] : projects.filter((p) => !linked.has(p.id));
  const statuses = await Promise.all(
    sites.map((s) => softly(() => siteDomainStatus(siteDeps(), client, s.id))),
  );
  // Names live in the brief, in the client's own database. A site with a brief was started
  // in Locus (so it has a version) and can be built; a linked project without one can't.
  const briefs = await softly(() =>
    siteNames(
      siteBuilderDeps(),
      client,
      sites.map((s) => s.id),
    ),
  );
  const briefNames = isProblem(briefs) ? new Map<string, string>() : briefs;
  // What each published site's forms sent to the CRM lately, counted in the client's database.
  const published = sites.filter((s) => s.status !== "draft").map((s) => s.id);
  const leads = await softly(() => siteLeadTotals(siteBuilderDeps(), client, published));
  const leadTotals = isProblem(leads) ? undefined : leads;
  // Publishing: a site started in Locus gets a repository, then a Vercel project that builds it.
  const needsRepo = (s: (typeof sites)[number]) => !s.repoFullName && !s.hostProjectId;
  const repos: InstallationRepo[] | { problem: string } =
    manager && sites.some(needsRepo)
      ? await softly(
          () => listInstallationRepos(publishDeps(), ctx),
          "Publishing to GitHub isn't set up here yet.",
        )
      : [];
  const repoChoices = isProblem(repos) ? [] : linkableRepos(repos, sites);
  const deployments = await Promise.all(
    sites.map((s) =>
      s.host === "vercel" && s.hostProjectId && !gone(s.hostProjectId)
        ? softly(() => latestDeployment(siteDeps(), client, s.id))
        : undefined,
    ),
  );

  return (
    <Page title={`Sites · ${client.location.name}`}>
      {error && <Notice tone="error">{error}</Notice>}
      {!builderOn && (
        <Notice tone="info">
          The site builder is turned off for this client, so its sites can't be created, copied in,
          built or published. {manager ? "Turn it on" : "An owner or admin can turn it on"} on the{" "}
          <Link href="/clients" className="underline">
            Clients
          </Link>{" "}
          page.
        </Notice>
      )}
      {created && <Notice tone="info">Site created from its template as version 1.</Notice>}
      {deleted && <Notice tone="info">Site deleted.</Notice>}
      {copied === "here" && (
        <Notice tone="info">Site copied as a new draft. The site builder now works on it.</Notice>
      )}
      {copied === "elsewhere" && (
        <Notice tone="info">
          Site copied as a new draft. Switch to that client on the{" "}
          <Link href="/clients" className="underline">
            Clients
          </Link>{" "}
          page to see it.
        </Notice>
      )}
      {publishedVersion && /^\d{1,6}$/.test(publishedVersion) && (
        <Notice tone="info">
          Version {publishedVersion} sent to GitHub.
          {deploys ? " Vercel deploys it in a minute or two." : ""}
        </Notice>
      )}
      {chosen && <Notice tone="info">The site builder now works on that site.</Notice>}
      {isProblem(projects) && (
        <Notice tone="error">
          {projects.problem}{" "}
          <Link href="/connect" className="underline">
            Connections
          </Link>
        </Notice>
      )}

      {sites.length === 0 && (
        <p className="text-neutral-600">
          This client has no site yet. Create one below, or link the Vercel project it already runs
          on to connect its domain.
        </p>
      )}

      {order.map(({ s, i }, n) => {
        const status = statuses[i];
        const previous = order[n - 1]?.s.folder ?? null;
        // A heading where a folder starts, and before the unfiled sites when there are folders.
        const heading =
          folders.length > 0 && (n === 0 || previous !== s.folder)
            ? (s.folder ?? "No folder")
            : null;
        return (
          <div key={s.id} className="space-y-3">
            {heading && (
              <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
                {heading}
              </h2>
            )}
            <section className="space-y-3 rounded-md border border-neutral-200 p-4">
              {/* A site started in Locus keeps its own name once it has a Vercel project. */}
              <h2 className="font-semibold">
                {briefNames.get(s.id) ??
                  names.get(s.hostProjectId ?? "") ??
                  s.hostProjectId ??
                  "Untitled site"}
              </h2>
              {!briefNames.has(s.id) ? null : viewOnly.has(s.id) ? (
                <p className="text-sm text-neutral-600">
                  You can view this site but not change it.
                </p>
              ) : !builderOn ? null : activeSite === s.id ? (
                <p className="text-sm text-neutral-600">The site builder works on this site.</p>
              ) : (
                <form action={chooseSite} className="text-sm">
                  <input type="hidden" name="siteId" value={s.id} />
                  <button type="submit" className="underline">
                    Build this site
                  </button>
                </form>
              )}
              {!s.hostProjectId && !s.customDomain ? (
                <p className="text-sm text-neutral-600">
                  Draft{s.repoFullName ? `, saved to ${s.repoFullName}` : ""}. Not published yet.
                </p>
              ) : isProblem(status) ? (
                <>
                  {s.customDomain && (
                    <p>
                      <strong>{s.customDomain}</strong>
                    </p>
                  )}
                  <Notice tone="error">{status.problem}</Notice>
                  {manager && s.customDomain && <RemoveDomain siteId={s.id} />}
                </>
              ) : status ? (
                <DomainPanel status={status} siteId={s.id} manager={manager} />
              ) : manager ? (
                <form action={addSiteDomain} className="space-y-2">
                  <input type="hidden" name="siteId" value={s.id} />
                  <Field
                    label="Domain"
                    name="domain"
                    placeholder="www.example.com"
                    required
                    autoComplete="off"
                  />
                  <p className="text-sm text-neutral-600">
                    The domain stays where it's registered. Locus tells you which DNS records to add
                    there.
                  </p>
                  <Button>Connect domain</Button>
                </form>
              ) : (
                <p className="text-sm text-neutral-600">No domain yet.</p>
              )}
              {s.status !== "draft" && leadTotals && <FormLeads totals={leadTotals.get(s.id)} />}
              {manager && needsRepo(s) && (
                <RepoForm
                  siteId={s.id}
                  suggested={suggestedRepoName(briefNames.get(s.id))}
                  repos={repos}
                  choices={repoChoices}
                />
              )}
              {manager && builderOn && s.repoFullName && briefNames.has(s.id) && (
                <form action={publishSite} className="space-y-2">
                  <input type="hidden" name="siteId" value={s.id} />
                  {s.hostProjectId && <input type="hidden" name="deploys" value="yes" />}
                  <p className="text-sm text-neutral-600">
                    Publishing sends the site's latest saved version to {s.repoFullName}
                    {s.hostProjectId ? ", and Vercel deploys it" : ""}.
                  </p>
                  <Button>Publish the latest version</Button>
                </form>
              )}
              {manager && s.repoFullName && !s.hostProjectId && (
                <ProjectForm
                  siteId={s.id}
                  problem={isProblem(projects) ? projects.problem : null}
                />
              )}
              {deployments[i] !== undefined && <DeploymentLine deployment={deployments[i]} />}
              {gone(s.hostProjectId) && (
                <Notice tone="error">This project is no longer on your Vercel team.</Notice>
              )}
              {manager && s.hostProjectId && !s.customDomain && (
                <form action={unlinkSiteProject} className="text-sm">
                  <input type="hidden" name="siteId" value={s.id} />
                  <button type="submit" className="underline">
                    Unlink project
                  </button>
                </form>
              )}
              {!viewOnly.has(s.id) && (
                <FolderForm siteId={s.id} folder={s.folder} folders={folders} />
              )}
              {briefNames.has(s.id) && canBuild(s.id) && (
                <CopyForm
                  siteId={s.id}
                  name={briefNames.get(s.id) ?? ""}
                  clientId={client.location.id}
                  clients={clients}
                />
              )}
              {(siteMembers[i]?.length ?? 0) > 0 && (
                <AccessForm siteId={s.id} members={siteMembers[i] ?? []} />
              )}
              {manager && !s.hostProjectId && !s.customDomain && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-neutral-600">Delete this site</summary>
                  <form action={deleteSite} className="space-y-2 pt-2">
                    <input type="hidden" name="siteId" value={s.id} />
                    {s.repoFullName && (
                      <p className="text-neutral-600">
                        Its GitHub repository {s.repoFullName} stays; delete it on GitHub if you no
                        longer need it.
                      </p>
                    )}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="confirm" value="yes" required />
                      Delete this site and all its versions from Locus. This can't be undone.
                    </label>
                    <Button>Delete site</Button>
                  </form>
                </details>
              )}
            </section>
          </div>
        );
      })}

      {builderOn && (
        <form action={createSite} className="space-y-2 pt-2">
          <h2 className="font-semibold">New site</h2>
          <Field
            label="Name"
            name="name"
            placeholder="Bright Smiles Dental"
            required
            maxLength={120}
          />
          <label className="block text-sm">
            <span className="text-neutral-700">Kind</span>
            <select
              name="kind"
              defaultValue="website"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
            >
              {SITE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-neutral-700">Template</span>
            <select
              name="templateId"
              defaultValue=""
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
            >
              <option value="">The one that fits the kind</option>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}: {t.summary}
                </option>
              ))}
            </select>
          </label>
          <Button>Create site</Button>
        </form>
      )}

      {linkable.length > 0 && (
        <form action={linkSiteProject} className="space-y-2 pt-2">
          <label className="block text-sm">
            <span className="text-neutral-700">Link a Vercel project to this client</span>
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
          <Button>Link project</Button>
        </form>
      )}
    </Page>
  );
}

/** Which members who work on this client may only view the site; the rest manage it. */
function AccessForm({ siteId, members }: { siteId: string; members: SiteMember[] }) {
  const viewers = members.filter((m) => m.level === "view").length;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-neutral-600">
        Who can change it
        {viewers > 0 ? ` (${viewers} view only)` : ""}
      </summary>
      <form action={saveSiteAccess} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <p className="text-neutral-600">
          Members who work on this client can build and change the site. Tick the ones who should
          only view it. Owners and admins can always change it.
        </p>
        {members.map((m) => (
          <label key={m.memberId} className="flex items-center gap-2">
            <input
              type="checkbox"
              name="viewOnly"
              value={m.memberId}
              defaultChecked={m.level === "view"}
            />
            {m.name} <span className="text-neutral-500">· {m.email} · view only</span>
          </label>
        ))}
        <Button>Save access</Button>
      </form>
    </details>
  );
}

/** Files the site under a folder: one already used, a new name, or none. */
function FolderForm({
  siteId,
  folder,
  folders,
}: {
  siteId: string;
  folder: string | null;
  folders: string[];
}) {
  const listId = `folders-${siteId}`;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-neutral-600">
        {folder ? `In the folder ${folder}. Move it` : "Put it in a folder"}
      </summary>
      <form action={fileSite} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <label className="block">
          <span className="text-neutral-700">Folder</span>
          <input
            name="folder"
            list={listId}
            defaultValue={folder ?? ""}
            maxLength={MAX_FOLDER_LENGTH}
            placeholder="A new or existing folder; empty for none"
            autoComplete="off"
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
          />
          <datalist id={listId}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <Button>Save folder</Button>
      </form>
    </details>
  );
}

/** Copies the site's latest saved version into a new draft, here or for another client. */
function CopyForm({
  siteId,
  name,
  clientId,
  clients,
}: {
  siteId: string;
  name: string;
  clientId: string;
  clients: { id: string; name: string }[];
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-neutral-600">Copy this site</summary>
      <form action={copySite} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <Field
          label="Name of the copy"
          name="name"
          defaultValue={`Copy of ${name}`.slice(0, 120)}
          required
          maxLength={120}
        />
        {clients.length > 1 && (
          <label className="block">
            <span className="text-neutral-700">For which client</span>
            <select
              name="targetClientId"
              defaultValue={clientId}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === clientId ? `${c.name} (this client)` : c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-neutral-600">
          The copy starts from this site's latest saved version, as a new draft. It doesn't take the
          version history, the repository, the Vercel project or the domain.
        </p>
        <Button>Copy site</Button>
      </form>
    </details>
  );
}

function DomainPanel({
  status,
  siteId,
  manager,
}: {
  status: DomainStatus;
  siteId: string;
  manager: boolean;
}) {
  return (
    <div className="space-y-3">
      <p>
        <strong>{status.domain}</strong>
      </p>
      <Notice tone="info">{STATE[status.state]}</Notice>
      {status.records.length > 0 && (
        <div className="space-y-2 text-sm">
          <p className="text-neutral-600">
            Add at the DNS provider for <strong>{status.records[0]?.zone}</strong>:
          </p>
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="w-16 py-1">Type</th>
                <th className="w-1/3 py-1">Name</th>
                <th className="py-1">Value</th>
              </tr>
            </thead>
            <tbody>
              {status.records.map((r) => (
                <tr key={`${r.type}-${r.name}-${r.value}`} className="border-t border-neutral-200">
                  <td className="py-1 align-top">{r.type}</td>
                  <td className="break-all py-1 align-top font-mono">{r.name}</td>
                  <td className="break-all py-1 align-top font-mono">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.state === "point" && (
            <p className="text-neutral-600">
              If the DNS is on Cloudflare, set the record to "DNS only" (grey cloud).
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-4 text-sm">
        {status.state !== "live" && (
          // A full load, so Vercel is asked again.
          <a href="/sites" className="underline">
            Check again
          </a>
        )}
        {manager && <RemoveDomain siteId={siteId} />}
      </div>
    </div>
  );
}

function ConnectFirst({ problem }: { problem: string }) {
  return (
    <Notice tone="error">
      {problem}{" "}
      <Link href="/connect" className="underline">
        Connections
      </Link>
    </Notice>
  );
}

/** Gives a draft site a GitHub repository: a new private one, or an existing empty one. */
function RepoForm({
  siteId,
  suggested,
  repos,
  choices,
}: {
  siteId: string;
  suggested: string;
  repos: InstallationRepo[] | { problem: string };
  choices: InstallationRepo[];
}) {
  if (isProblem(repos)) return <ConnectFirst problem={repos.problem} />;
  return (
    <form action={giveSiteRepository} className="space-y-2">
      <input type="hidden" name="siteId" value={siteId} />
      <label className="block text-sm">
        <span className="text-neutral-700">GitHub repository</span>
        <select
          name="repo"
          defaultValue=""
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
        >
          <option value="">Create a new private repository</option>
          {choices.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              Link {r.fullName}
            </option>
          ))}
        </select>
      </label>
      <Field
        label="New repository name"
        name="name"
        defaultValue={suggested}
        maxLength={100}
        autoComplete="off"
      />
      <p className="text-sm text-neutral-600">
        Each saved version replaces everything in the repository, so Locus only links an empty one
        and refuses a repository that already has code.
      </p>
      <Button>Give the site a repository</Button>
    </form>
  );
}

/** Gives a site with a repository a Vercel project that builds it. */
function ProjectForm({ siteId, problem }: { siteId: string; problem: string | null }) {
  if (problem) return <ConnectFirst problem={problem} />;
  return (
    <form action={giveSiteVercelProject} className="space-y-2">
      <input type="hidden" name="siteId" value={siteId} />
      <p className="text-sm text-neutral-600">
        A project on your Vercel team builds the repository and deploys each save.
      </p>
      <Button>Create Vercel project</Button>
    </form>
  );
}

function DeploymentLine({
  deployment,
}: {
  deployment: SiteDeployment | null | { problem: string };
}) {
  if (isProblem(deployment)) return <Notice tone="error">{deployment.problem}</Notice>;
  if (!deployment) return <p className="text-sm text-neutral-600">No deployment yet.</p>;
  return (
    <p className="text-sm text-neutral-600">
      Latest deployment: {deploymentLabel(deployment.state)}
      {deployment.url && (
        <>
          {" · "}
          <a href={deployment.url} className="underline" target="_blank" rel="noreferrer">
            {deployment.url.replace(/^https:\/\//, "")}
          </a>
        </>
      )}
    </p>
  );
}

function RemoveDomain({ siteId }: { siteId: string }) {
  return (
    <form action={deleteSiteDomain} className="text-sm">
      <input type="hidden" name="siteId" value={siteId} />
      <button type="submit" className="underline">
        Remove domain
      </button>
    </form>
  );
}

/** What the site's forms sent to the CRM over the last days, and what didn't get there. */
function FormLeads({ totals }: { totals: { delivered: number; failed: number } | undefined }) {
  const delivered = totals?.delivered ?? 0;
  const failed = totals?.failed ?? 0;
  const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;
  return (
    <p className="text-sm text-neutral-600">
      Forms: {leads(delivered)} sent to the CRM in the last {LEAD_TOTAL_DAYS} days
      {failed > 0 && (
        <span className="text-red-700">
          , {leads(failed)} that couldn't be sent. Check the client's CRM connection.
        </span>
      )}
      {failed === 0 && "."}
    </p>
  );
}
