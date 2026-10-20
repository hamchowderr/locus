import {
  ClientAccessDenied,
  listAccessibleClients,
  requireAgencyManager,
  resolveActiveClient,
} from "@locus/auth";
import {
  agencyGithubAccount,
  ConnectError,
  type DomainState,
  type DomainStatus,
  type HostProject,
  type HostProjectList,
  type InstallationAccount,
  type InstallationRepo,
  latestDeployment,
  listHostProjects,
  listInstallationRepos,
  listSites,
  MAX_FOLDER_LENGTH,
  type SiteDeployment,
  siteDomainStatus,
} from "@locus/connect";
import {
  DESIGN_QUESTIONS,
  FONT_PRESETS,
  MAX_SCREENSHOT_BYTES,
  PALETTE_PRESETS,
  SITE_KINDS,
  TEMPLATES,
} from "@locus/studio";
import Link from "next/link";
import { redirect } from "next/navigation";
import { publishDeps, siteDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import {
  activeSiteIdForSession,
  LEAD_TOTAL_DAYS,
  type SiteSeo,
  siteLeadTotals,
  siteNames,
  siteSeo,
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
  const briefs = await softly(
    () =>
      siteNames(
        siteBuilderDeps(),
        client,
        sites.map((s) => s.id),
      ),
    "Site building isn't set up here yet.",
  );
  const briefNames = isProblem(briefs) ? new Map<string, string>() : briefs;
  // What each published site's forms sent to the CRM lately, counted in the client's database.
  const published = sites.filter((s) => s.status !== "draft").map((s) => s.id);
  const leads = await softly(() => siteLeadTotals(siteBuilderDeps(), client, published));
  const leadTotals = isProblem(leads) ? undefined : leads;
  // What search engines will see of each site started in Locus, from its latest version.
  const seo = await softly(() => siteSeo(siteBuilderDeps(), client, [...briefNames.keys()]));
  const seoChecks = isProblem(seo) ? new Map<string, SiteSeo>() : seo;
  // Publishing: a site started in Locus gets a repository, then a Vercel project that builds it.
  const needsRepo = (s: (typeof sites)[number]) => !s.repoFullName && !s.hostProjectId;
  // On a personal account Locus can't create repositories, so the form only links one.
  const [repos, githubAccount]: [
    InstallationRepo[] | { problem: string },
    InstallationAccount | { problem: string } | undefined,
  ] =
    manager && sites.some(needsRepo)
      ? await Promise.all([
          softly(
            () => listInstallationRepos(publishDeps(), ctx),
            "Publishing to GitHub isn't set up here yet.",
          ),
          softly(() => agencyGithubAccount(publishDeps(), ctx)),
        ])
      : [[], undefined];
  const repoChoices = isProblem(repos) ? [] : linkableRepos(repos, sites);
  const account = githubAccount && !isProblem(githubAccount) ? githubAccount : undefined;
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
      {isProblem(briefs) && sites.length > 0 && (
        <Notice tone="error">
          Building and publishing are hidden because Locus couldn't read this client's site details.{" "}
          {briefs.problem}
        </Notice>
      )}
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
              {briefNames.has(s.id) && (
                <p className="flex gap-4 text-sm">
                  <Link href={`/sites/${s.id}/preview`} className="underline">
                    Preview
                  </Link>
                  <Link href={`/sites/${s.id}/versions`} className="underline">
                    Versions
                  </Link>
                </p>
              )}
              {!briefNames.has(s.id) ? null : activeSite === s.id ? (
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
              {seoChecks.has(s.id) && <SeoCheck check={seoChecks.get(s.id) as SiteSeo} />}
              {manager && needsRepo(s) && (
                <RepoForm
                  siteId={s.id}
                  suggested={suggestedRepoName(briefNames.get(s.id))}
                  repos={repos}
                  choices={repoChoices}
                  account={account}
                />
              )}
              {manager && s.repoFullName && briefNames.has(s.id) && (
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
              {manager &&
                s.repoFullName &&
                !s.hostProjectId &&
                // Vercel would fail to build an empty repository, so the site is published first.
                (s.status === "draft" ? (
                  <p className="text-sm text-neutral-600">
                    Publish the site to {s.repoFullName} first, then create its Vercel project.
                  </p>
                ) : (
                  <ProjectForm
                    siteId={s.id}
                    problem={isProblem(projects) ? projects.problem : null}
                  />
                ))}
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
              <FolderForm siteId={s.id} folder={s.folder} folders={folders} />
              {briefNames.has(s.id) && (
                <CopyForm
                  siteId={s.id}
                  name={briefNames.get(s.id) ?? ""}
                  clientId={client.location.id}
                  clients={clients}
                />
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
        <StartingPoints />
        <Button>Create site</Button>
      </form>

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
        {status.state === "live" && (
          <>
            {" · "}
            <a
              href={`https://${status.domain}`}
              className="text-sm underline"
              target="_blank"
              rel="noreferrer"
            >
              the site's main address
            </a>
          </>
        )}
      </p>
      <Notice tone="info">{STATE[status.state]}</Notice>
      <DnsRecords state={status} />
      {status.redirect && (
        <div className="space-y-2">
          <p className="text-sm">
            <strong>{status.redirect.domain}</strong> sends visitors to {status.domain}.{" "}
            {status.redirect.state === "live"
              ? "It works."
              : "It needs its own record too, then check again."}
          </p>
          <DnsRecords state={status.redirect} />
        </div>
      )}
      {status.partner && manager && (
        <form action={addSiteDomain} className="text-sm">
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="domain" value={status.domain} />
          <button type="submit" className="underline">
            Also send {status.partner} to {status.domain}
          </button>
        </form>
      )}
      <div className="flex items-center gap-4 text-sm">
        {(status.state !== "live" || (status.redirect && status.redirect.state !== "live")) && (
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

/** The DNS records one domain still needs, to add at its DNS provider. */
function DnsRecords({ state }: { state: DomainState }) {
  if (state.records.length === 0) return null;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-neutral-600">
        Add at the DNS provider for <strong>{state.records[0]?.zone}</strong>:
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
          {state.records.map((r) => (
            <tr key={`${r.type}-${r.name}-${r.value}`} className="border-t border-neutral-200">
              <td className="py-1 align-top">{r.type}</td>
              <td className="break-all py-1 align-top font-mono">{r.name}</td>
              <td className="break-all py-1 align-top font-mono">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {state.state === "point" && (
        <p className="text-neutral-600">
          If the DNS is on Cloudflare, set the record to "DNS only" (grey cloud).
        </p>
      )}
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

/**
 * Gives a draft site a GitHub repository: a new private one, or an existing empty one. On a
 * personal GitHub account it can only link one, since GitHub Apps can't create repositories there.
 */
function RepoForm({
  siteId,
  suggested,
  repos,
  choices,
  account,
}: {
  siteId: string;
  suggested: string;
  repos: InstallationRepo[] | { problem: string };
  choices: InstallationRepo[];
  account: InstallationAccount | undefined;
}) {
  if (isProblem(repos)) return <ConnectFirst problem={repos.problem} />;
  const personal = account?.personal === true;
  const howTo = account && personal && (
    <p className="text-sm text-neutral-600">
      Locus can't create repositories in your personal GitHub account {account.login}.{" "}
      <a href="https://github.com/new" className="underline" target="_blank" rel="noreferrer">
        Create an empty private repository (opens in a new tab)
      </a>{" "}
      (leave out the README),{" "}
      <a
        href={`https://github.com/settings/installations/${encodeURIComponent(account.installationId)}`}
        className="underline"
        target="_blank"
        rel="noreferrer"
      >
        give the Locus app access to it (opens in a new tab)
      </a>
      , then reload this page and pick it here.
    </p>
  );
  if (personal && choices.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-neutral-700">This site needs a GitHub repository.</p>
        {howTo}
      </div>
    );
  }
  return (
    <form action={giveSiteRepository} className="space-y-2">
      <input type="hidden" name="siteId" value={siteId} />
      <label className="block text-sm">
        <span className="text-neutral-700">GitHub repository</span>
        <select
          name="repo"
          defaultValue=""
          required={personal}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
        >
          {personal ? (
            <option value="" disabled>
              Pick an empty repository
            </option>
          ) : (
            <option value="">Create a new private repository</option>
          )}
          {choices.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              Link {r.fullName}
            </option>
          ))}
        </select>
      </label>
      {!personal && (
        <Field
          label="New repository name"
          name="name"
          defaultValue={suggested}
          maxLength={100}
          autoComplete="off"
        />
      )}
      {howTo}
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
          {" · Preview address "}
          <a href={deployment.url} className="underline" target="_blank" rel="noreferrer">
            {deployment.url.replace(/^https:\/\//, "")}
          </a>
          {" (always on, good for sharing before the domain works)"}
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

/** Each page's search title and description in the latest version, and what to fix. */
function SeoCheck({ check }: { check: SiteSeo }) {
  const { issues, pages } = check;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-neutral-600">
        Search check (version {check.version}):{" "}
        {issues.length === 0
          ? "nothing to fix."
          : `${issues.length} ${issues.length === 1 ? "thing" : "things"} to fix.`}
      </summary>
      <div className="space-y-3 pt-2">
        {issues.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-red-700">
            {issues.map((issue) => (
              <li key={`${issue.page} ${issue.problem}`}>
                {issue.page === "site" ? "Whole site" : issue.page}: {issue.problem}
              </li>
            ))}
          </ul>
        )}
        <ul className="space-y-2">
          {pages.map((page) => (
            <li key={page.path}>
              <span className="font-mono">{page.path}</span>
              {page.noindex && <span className="text-neutral-600"> (kept out of search)</span>}
              <br />
              <span>{page.title ?? (page.hasTitle ? "Title set in code" : "No title")}</span>
              {" · "}
              <span className="text-neutral-600">
                {page.description ??
                  (page.hasDescription ? "Description set in code" : "No description")}
              </span>
              {page.schema && <span className="text-neutral-600"> · Structured data</span>}
            </li>
          ))}
        </ul>
        <p className="text-neutral-600">
          Every published site also gets a sitemap, robots.txt, llms.txt and the business's
          structured data. They use the site's own domain once it's live, so publish again after the
          domain starts working. Ask the site builder in the chat to fix anything listed.
        </p>
      </div>
    </details>
  );
}

const SELECT = "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base";
const options = (id: string) => DESIGN_QUESTIONS.find((q) => q.id === id)?.options ?? [];

/**
 * Optional starting points for a new site: the guided design questions, a site the person
 * likes and a screenshot. The builder asks in the chat for anything left out.
 */
function StartingPoints() {
  return (
    <details className="space-y-3 rounded-md border border-neutral-200 p-3 text-sm">
      <summary className="cursor-pointer text-neutral-700">
        Describe it, or start from a site you like (optional)
      </summary>
      <label className="block">
        <span className="text-neutral-700">What should the site do?</span>
        <textarea
          name="description"
          rows={3}
          maxLength={4000}
          placeholder="A friendly site for a family dental practice that gets people to book a cleaning."
          className={SELECT}
        />
      </label>
      <Choice name="goal" label="What should a visitor do?" choices={options("goal")} />
      <Choice name="audience" label="Who is it for?" choices={options("audience")} />
      <Choice name="palette" label="Colours" choices={Object.keys(PALETTE_PRESETS)} />
      <Choice name="fonts" label="Lettering" choices={Object.keys(FONT_PRESETS)} />
      <label className="block">
        <span className="text-neutral-700">Layout</span>
        <select name="layout" defaultValue="" className={SELECT}>
          <option value="">Let the builder decide</option>
          <option value="single-page">One page</option>
          <option value="multi-page">Several pages</option>
        </select>
      </label>
      <fieldset>
        <legend className="text-neutral-700">Pages it needs</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {options("pages").map((page) => (
            <label key={page} className="flex items-center gap-1">
              <input type="checkbox" name="pages" value={page} />
              {page}
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        label="A site you like"
        name="referenceUrl"
        placeholder="example.com"
        maxLength={2000}
        autoComplete="off"
      />
      <label className="block">
        <span className="text-neutral-700">
          A screenshot you like (PNG, JPEG or WebP, up to {MAX_SCREENSHOT_BYTES / 1024 / 1024} MB)
        </span>
        <input
          type="file"
          name="screenshot"
          accept="image/png,image/jpeg,image/webp"
          className="mt-1 block w-full text-sm"
        />
      </label>
      <p className="text-neutral-600">
        The builder takes ideas from the site and screenshot, never their words or pictures.
      </p>
    </details>
  );
}

function Choice({ name, label, choices }: { name: string; label: string; choices: string[] }) {
  return (
    <label className="block">
      <span className="text-neutral-700">{label}</span>
      <select name={name} defaultValue="" className={SELECT}>
        <option value="">Let the builder ask</option>
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}
