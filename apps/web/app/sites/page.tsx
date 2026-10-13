import { ClientAccessDenied, requireAgencyManager, resolveActiveClient } from "@locus/auth";
import {
  ConnectError,
  type DomainStatus,
  type HostProject,
  listHostProjects,
  listSites,
  siteDomainStatus,
} from "@locus/connect";
import Link from "next/link";
import { redirect } from "next/navigation";
import { siteDeps } from "@/lib/hosts";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { addSiteDomain, deleteSiteDomain, linkSiteProject } from "../actions";
import { Button, Field, Notice, Page } from "../ui";

const STATE: Record<DomainStatus["state"], string> = {
  verify: "Waiting for Vercel to verify the domain. Add this record, then check again.",
  point: "Verified. Now point the domain at Vercel with this record, then check again.",
  live: "Live. The site is served on this domain.",
};

/** A Vercel or configuration problem as text for the page, instead of failing it. */
async function softly<T>(run: () => Promise<T>): Promise<T | { problem: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) return { problem: error.message };
    if (error instanceof NotConfigured) return { problem: "Vercel isn't set up here yet." };
    throw error;
  }
}
const isProblem = (value: unknown): value is { problem: string } =>
  typeof value === "object" && value !== null && "problem" in value;

export default async function Sites({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error } = await searchParams;
  const ctx = sessionContext(current);
  const client = await resolveActiveClient(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");

  const manager = await requireAgencyManager(locus().db, ctx).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const sites = await listSites(locus().db, client);
  const projects: HostProject[] | { problem: string } = manager
    ? await softly(() => listHostProjects(siteDeps(), ctx))
    : [];
  const names = new Map(isProblem(projects) ? [] : projects.map((p) => [p.id, p.name]));
  const linked = new Set(sites.map((s) => s.hostProjectId));
  const linkable = isProblem(projects) ? [] : projects.filter((p) => !linked.has(p.id));
  const statuses = await Promise.all(
    sites.map((s) => softly(() => siteDomainStatus(siteDeps(), client, s.id))),
  );

  return (
    <Page title={`Sites · ${client.location.name}`}>
      {error && <Notice tone="error">{error}</Notice>}
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
          This client has no site yet. Link the Vercel project it runs on to connect its domain.
        </p>
      )}

      {sites.map((s, i) => {
        const status = statuses[i];
        return (
          <section key={s.id} className="space-y-3 rounded-md border border-neutral-200 p-4">
            <h2 className="font-semibold">
              {names.get(s.hostProjectId ?? "") ?? s.hostProjectId ?? "Site"}
            </h2>
            {isProblem(status) ? (
              <Notice tone="error">{status.problem}</Notice>
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
          </section>
        );
      })}

      {linkable.length > 0 && (
        <form action={linkSiteProject} className="space-y-2 pt-2">
          <label className="block text-sm">
            <span className="text-neutral-700">Link a Vercel project to this client</span>
            <select
              name="projectId"
              required
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
            >
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
        {manager && (
          <form action={deleteSiteDomain}>
            <input type="hidden" name="siteId" value={siteId} />
            <button type="submit" className="underline">
              Remove domain
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
