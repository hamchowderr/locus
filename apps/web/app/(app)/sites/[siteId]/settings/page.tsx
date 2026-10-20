import { listAccessibleClients, listSiteMembers, type SiteMember } from "@locus/auth";
import {
  agencyGithubAccount,
  ConnectError,
  type InstallationAccount,
  type InstallationRepo,
  latestDeployment,
  listHostProjects,
  listInstallationRepos,
  listSites,
  siteDomainStatus,
} from "@locus/connect";
import type { ReactNode } from "react";
import { addSiteDomain, deleteSite, unlinkSiteProject } from "@/app/actions";
import { Button, Field, Notice } from "@/app/ui";
import { publishDeps, siteDeps } from "@/lib/hosts";
import { locus, NotConfigured } from "@/lib/locus";
import { siteLeadTotals, siteSeo } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { linkableRepos, suggestedRepoName } from "@/lib/site-publish";
import { siteForPage } from "../site";
import {
  AccessForm,
  CopyForm,
  DeploymentLine,
  DomainPanel,
  FolderForm,
  FormLeads,
  isProblem,
  ProjectForm,
  RemoveDomain,
  RepoForm,
  ReturnTo,
  SeoCheck,
} from "./parts";

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
    console.error("Site settings: a lookup failed", error);
    return { problem: "Locus couldn't load this just now. Reload to try again." };
  }
}

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A site's Settings tab: publishing (repository and Vercel), its domain, what its forms and
 * search check say, its folder, copies, who may change it, and deleting it.
 */
export default async function SiteSettings({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ error?: string; published?: string; deploys?: string }>;
}) {
  const { siteId } = await params;
  const { ctx, client, site, name, refusal, manager } = await siteForPage(
    siteId,
    `/sites/${siteId}/settings`,
  );
  const { error, published, deploys } = await searchParams;
  const db = locus().db;
  const started = name !== null;
  const builderOn = client.location.siteBuilder;

  // A project linked from the agency's Vercel team, if it still exists there.
  const listing =
    manager && site.hostProjectId ? await softly(() => listHostProjects(siteDeps(), ctx)) : null;
  const gone =
    listing !== null &&
    !isProblem(listing) &&
    listing.complete &&
    !listing.projects.some((p) => p.id === site.hostProjectId);
  const domain =
    site.hostProjectId || site.customDomain
      ? await softly(() => siteDomainStatus(siteDeps(), client, site.id))
      : null;
  const deployment =
    site.host === "vercel" && site.hostProjectId && !gone
      ? await softly(() => latestDeployment(siteDeps(), client, site.id))
      : undefined;
  // Publishing: a site started in Locus gets a repository, then a Vercel project that builds it.
  const needsRepo = !site.repoFullName && !site.hostProjectId;
  let repos: InstallationRepo[] | { problem: string } = [];
  let account: InstallationAccount | undefined;
  let choices: InstallationRepo[] = [];
  const sites = await listSites(db, client);
  if (manager && needsRepo && started) {
    const [found, github] = await Promise.all([
      softly(
        () => listInstallationRepos(publishDeps(), ctx),
        "Publishing to GitHub isn't set up here yet.",
      ),
      softly(() => agencyGithubAccount(publishDeps(), ctx)),
    ]);
    repos = found;
    account = isProblem(github) ? undefined : github;
    choices = isProblem(found) ? [] : linkableRepos(found, sites);
  }
  const projectProblem = listing && isProblem(listing) ? listing.problem : null;
  const leads =
    site.status !== "draft"
      ? await softly(() => siteLeadTotals(siteBuilderDeps(), client, [site.id]))
      : null;
  const seo = started ? await softly(() => siteSeo(siteBuilderDeps(), client, [site.id])) : null;
  const seoCheck = seo && !isProblem(seo) ? seo.get(site.id) : undefined;
  const folder = sites.find((s) => s.id === site.id)?.folder ?? null;
  const folders = [...new Set(sites.flatMap((s) => (s.folder ? [s.folder] : [])))].sort((a, b) =>
    a.localeCompare(b),
  );
  const members: SiteMember[] = manager ? await listSiteMembers(db, ctx, client, site.id) : [];
  const clients = await listAccessibleClients(db, ctx);
  const viewOnly = refusal !== null && builderOn;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8">
      {error && <Notice tone="error">{error}</Notice>}
      {published && /^\d{1,6}$/.test(published) && (
        <Notice tone="info">
          Version {published} sent to GitHub.
          {deploys ? " Vercel deploys it in a minute or two." : ""}
        </Notice>
      )}
      {refusal && <Notice tone="info">{refusal}</Notice>}

      <Section title="Publishing" id="publishing">
        {!started ? (
          <p className="text-sm text-neutral-600">
            This site's Vercel project was linked to the sub-account; it's published from wherever
            its code lives.
          </p>
        ) : site.repoFullName ? (
          <p className="text-sm text-neutral-600">
            Publish sends the latest saved version to {site.repoFullName}
            {site.hostProjectId ? ", and Vercel deploys it" : ""}. The Publish button is at the top
            of every tab.
          </p>
        ) : !manager ? (
          <p className="text-sm text-neutral-600">
            Not published yet. An owner or admin sets up publishing.
          </p>
        ) : (
          <RepoForm
            siteId={site.id}
            suggested={suggestedRepoName(name ?? undefined)}
            repos={repos}
            choices={choices}
            account={account}
          />
        )}
        {manager &&
          site.repoFullName &&
          !site.hostProjectId &&
          // Vercel would fail to build an empty repository, so the site is published first.
          (site.status === "draft" ? (
            <p className="text-sm text-neutral-600">
              Publish the site to {site.repoFullName} first, then create its Vercel project here.
            </p>
          ) : (
            <ProjectForm siteId={site.id} problem={projectProblem} />
          ))}
        {deployment !== undefined && <DeploymentLine deployment={deployment} />}
        {gone && <Notice tone="error">This project is no longer on your Vercel team.</Notice>}
        {manager && site.hostProjectId && !site.customDomain && (
          <form action={unlinkSiteProject} className="text-sm">
            <input type="hidden" name="siteId" value={site.id} />
            <ReturnTo siteId={site.id} />
            <button type="submit" className="underline">
              Unlink the Vercel project
            </button>
          </form>
        )}
      </Section>

      <Section title="Domain">
        {!site.hostProjectId && !site.customDomain ? (
          <p className="text-sm text-neutral-600">
            A domain is connected once the site has a Vercel project (see Publishing).
          </p>
        ) : domain && isProblem(domain) ? (
          <>
            {site.customDomain && (
              <p>
                <strong>{site.customDomain}</strong>
              </p>
            )}
            <Notice tone="error">{domain.problem}</Notice>
            {manager && site.customDomain && <RemoveDomain siteId={site.id} />}
          </>
        ) : domain ? (
          <DomainPanel status={domain} siteId={site.id} manager={manager} />
        ) : manager ? (
          <form action={addSiteDomain} className="space-y-2">
            <input type="hidden" name="siteId" value={site.id} />
            <ReturnTo siteId={site.id} />
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
      </Section>

      {(leads || seoCheck) && (
        <Section title="Leads and search">
          {leads &&
            (isProblem(leads) ? (
              <Notice tone="error">{leads.problem}</Notice>
            ) : (
              <FormLeads totals={leads.get(site.id)} />
            ))}
          {seoCheck && <SeoCheck check={seoCheck} />}
        </Section>
      )}

      {!viewOnly && (
        <Section title="Folder">
          <FolderForm siteId={site.id} folder={folder} folders={folders} />
        </Section>
      )}

      {started && !refusal && (
        <Section title="Copy this site">
          <CopyForm
            siteId={site.id}
            name={name ?? ""}
            clientId={client.location.id}
            clients={clients}
          />
        </Section>
      )}

      {members.length > 0 && (
        <Section title="Who can change it">
          <AccessForm siteId={site.id} members={members} />
        </Section>
      )}

      {manager && !site.hostProjectId && !site.customDomain && (
        <Section title="Delete this site">
          <form action={deleteSite} className="space-y-2 text-sm">
            <input type="hidden" name="siteId" value={site.id} />
            <ReturnTo siteId={site.id} />
            {site.repoFullName && (
              <p className="text-neutral-600">
                Its GitHub repository {site.repoFullName} stays; delete it on GitHub if you no
                longer need it.
              </p>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" value="yes" required />
              Delete this site and all its versions from Locus. This can't be undone.
            </label>
            <Button>Delete site</Button>
          </form>
        </Section>
      )}
    </div>
  );
}
