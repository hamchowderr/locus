import type { SiteMember } from "@locus/auth";
import {
  type DomainState,
  type DomainStatus,
  type InstallationAccount,
  type InstallationRepo,
  MAX_FOLDER_LENGTH,
  type SiteDeployment,
} from "@locus/connect";
import Link from "next/link";
import {
  addSiteDomain,
  copySite,
  deleteSiteDomain,
  fileSite,
  giveSiteRepository,
  giveSiteVercelProject,
  saveSiteAccess,
} from "@/app/actions";
import { Button, Field, Notice } from "@/app/ui";
import { LEAD_TOTAL_DAYS, type SiteSeo } from "@/lib/site-builder";
import { deploymentLabel } from "@/lib/site-publish";

/** The parts of a site's Settings tab. Every form comes back to the tab. */

export const settingsPath = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/settings`;

/** Brings a form back to the site's Settings tab. */
export function ReturnTo({ siteId }: { siteId: string }) {
  return <input type="hidden" name="returnTo" value={settingsPath(siteId)} />;
}

export const isProblem = (value: unknown): value is { problem: string } =>
  typeof value === "object" && value !== null && "problem" in value;

const STATE: Record<DomainStatus["state"], string> = {
  verify: "Waiting for Vercel to verify the domain. Add this record, then check again.",
  point: "Verified. Now point the domain at Vercel with this record, then check again.",
  live: "Live. The site is served on this domain.",
};

/** Which members who work on this sub-account may only view the site; the rest manage it. */
export function AccessForm({ siteId, members }: { siteId: string; members: SiteMember[] }) {
  return (
    <div className="text-sm">
      <form action={saveSiteAccess} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <ReturnTo siteId={siteId} />
        <p className="text-neutral-600">
          Members who work on this sub-account can build and change the site. Tick the ones who
          should only view it. Owners and admins can always change it.
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
    </div>
  );
}

/** Files the site under a folder: one already used, a new name, or none. */
export function FolderForm({
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
    <div className="text-sm">
      <form action={fileSite} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <ReturnTo siteId={siteId} />
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
    </div>
  );
}

/** Copies the site's latest saved version into a new draft, here or for another sub-account. */
export function CopyForm({
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
    <div className="text-sm">
      <form action={copySite} className="space-y-2 pt-2">
        <input type="hidden" name="siteId" value={siteId} />
        <ReturnTo siteId={siteId} />
        <Field
          label="Name of the copy"
          name="name"
          defaultValue={`Copy of ${name}`.slice(0, 120)}
          required
          maxLength={120}
        />
        {clients.length > 1 && (
          <label className="block">
            <span className="text-neutral-700">For which sub-account</span>
            <select
              name="targetClientId"
              defaultValue={clientId}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === clientId ? `${c.name} (this sub-account)` : c.name}
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
    </div>
  );
}

export function DomainPanel({
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
          <ReturnTo siteId={siteId} />
          <input type="hidden" name="domain" value={status.domain} />
          <button type="submit" className="underline">
            Also send {status.partner} to {status.domain}
          </button>
        </form>
      )}
      <div className="flex items-center gap-4 text-sm">
        {(status.state !== "live" || (status.redirect && status.redirect.state !== "live")) && (
          // A full load, so Vercel is asked again.
          <a href={settingsPath(siteId)} className="underline">
            Check again
          </a>
        )}
        {manager && <RemoveDomain siteId={siteId} />}
      </div>
    </div>
  );
}

/** The DNS records one domain still needs, to add at its DNS provider. */
export function DnsRecords({ state }: { state: DomainState }) {
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

export function ConnectFirst({ problem }: { problem: string }) {
  return (
    <Notice tone="error">
      {problem}{" "}
      <Link href="/connect" className="underline">
        Integrations
      </Link>
    </Notice>
  );
}

/**
 * Gives a draft site a GitHub repository: a new private one, or an existing empty one. On a
 * personal GitHub account it can only link one, since GitHub Apps can't create repositories there.
 */
export function RepoForm({
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
      <ReturnTo siteId={siteId} />
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
export function ProjectForm({ siteId, problem }: { siteId: string; problem: string | null }) {
  if (problem) return <ConnectFirst problem={problem} />;
  return (
    <form action={giveSiteVercelProject} className="space-y-2">
      <input type="hidden" name="siteId" value={siteId} />
      <ReturnTo siteId={siteId} />
      <p className="text-sm text-neutral-600">
        A project on your Vercel team builds the repository and deploys each save.
      </p>
      <Button>Create Vercel project</Button>
    </form>
  );
}

export function DeploymentLine({
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

export function RemoveDomain({ siteId }: { siteId: string }) {
  return (
    <form action={deleteSiteDomain} className="text-sm">
      <input type="hidden" name="siteId" value={siteId} />
      <ReturnTo siteId={siteId} />
      <button type="submit" className="underline">
        Remove domain
      </button>
    </form>
  );
}

/** What the site's forms sent to the CRM over the last days, and what didn't get there. */
export function FormLeads({
  totals,
}: {
  totals: { delivered: number; failed: number } | undefined;
}) {
  const delivered = totals?.delivered ?? 0;
  const failed = totals?.failed ?? 0;
  const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;
  return (
    <p className="text-sm text-neutral-600">
      Forms: {leads(delivered)} sent to the CRM in the last {LEAD_TOTAL_DAYS} days
      {failed > 0 && (
        <span className="text-red-700">
          , {leads(failed)} that couldn't be sent. Check the sub-account's HighLevel connection.
        </span>
      )}
      {failed === 0 && "."}
    </p>
  );
}

/** Each page's search title and description in the latest version, and what to fix. */
export function SeoCheck({ check }: { check: SiteSeo }) {
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
          domain starts working. Ask the site's chat on the Build tab to fix anything listed.
        </p>
      </div>
    </details>
  );
}
