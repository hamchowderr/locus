import { randomUUID } from "node:crypto";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
  siteAccessLevel,
} from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { auditLog, site } from "@locus/db/control";
import type { SecretStore } from "@locus/secrets";
import { and, eq, isNull } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import type { VercelGrant, VercelHttp } from "./vercel.ts";
import { hostGrant, refused, vercel } from "./vercel-api.ts";

// A client's site and its custom domain, on the agency's own Vercel team. Contracts read from
// vercel.com/docs on 2026-10-13: `GET /v10/projects`, `GET /v9/projects/{id}`,
// `POST /v10/projects/{id}/domains`, `GET /v9/projects/{id}/domains/{domain}`,
// `POST /v9/projects/{id}/domains/{domain}/verify`, `DELETE /v9/projects/{id}/domains/{domain}`
// and `GET /v6/domains/{domain}/config`. The domain stays at the client's own DNS provider:
// Locus only tells the agency which records to add there.

export interface SiteDeps {
  db: ControlDb;
  secrets: SecretStore;
  http?: VercelHttp;
}

export type SiteRow = typeof site.$inferSelect;

export interface HostProject {
  id: string;
  name: string;
}

/** One record the agency adds at the domain's DNS provider. */
export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  /** Relative to `zone`; "@" is the zone itself. */
  name: string;
  value: string;
  /** The domain whose DNS holds this record, e.g. "example.com". */
  zone: string;
  why: "verify" | "point";
}

export interface DomainStatus {
  domain: string;
  /**
   * `verify`: Vercel needs the TXT record before it will use the domain on this project.
   * `point`: verified, but the domain doesn't reach Vercel yet (or has no certificate yet).
   * `live`: serving this site.
   */
  state: "verify" | "point" | "live";
  records: DnsRecord[];
}

// Vercel's documented defaults, used when the config call recommends nothing.
const DEFAULT_CNAME = "cname.vercel-dns.com";
const DEFAULT_IPV4 = "76.76.21.21";

/**
 * A hostname as an agency would type it, cleaned: lower case, without a scheme, path, port or
 * trailing dot. Throws `ConnectError` unless it is a plain public hostname.
 */
export function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  domain = domain.split(/[/?#]/, 1)[0] ?? "";
  domain = domain.replace(/:\d+$/, "").replace(/\.$/, "");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const valid = new RegExp(`^(?:${label}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`);
  if (domain.length > 253 || !valid.test(domain)) {
    throw new ConnectError("That isn't a domain name. Enter one like www.example.com.");
  }
  if (domain.endsWith(".vercel.app")) {
    throw new ConnectError("That's already a Vercel address. Enter the client's own domain.");
  }
  return domain;
}

/** At most this many pages of 100 projects are listed for the picker. */
const MAX_PROJECT_PAGES = 10;

const projectPath = (projectId: string, rest = "") =>
  `/v9/projects/${encodeURIComponent(projectId)}${rest}`;

export interface HostProjectList {
  projects: HostProject[];
  /** False when the page cap stopped the listing: a project missing from it may still exist. */
  complete: boolean;
}

/** The projects on the agency's Vercel team, newest first, for linking one to a client. */
export async function listHostProjects(
  deps: SiteDeps,
  ctx: SessionContext,
): Promise<HostProjectList> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const grant = await hostGrant(deps, organizationId);
  const projects: HostProject[] = [];
  // Pages of 100, newest first; `pagination.next` is the `until` for the next page.
  let until: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const result = await vercel<{
      projects?: { id: string; name: string }[];
      pagination?: { next?: number | null };
    }>(deps, grant, "GET", "/v10/projects", {
      query: { limit: "100", ...(until ? { until } : {}) },
    });
    if (!result.ok) throw refused(result, "Vercel didn't list your projects. Try again.");
    projects.push(...(result.body.projects ?? []).map(({ id, name }) => ({ id, name })));
    const next = result.body.pagination?.next;
    if (next == null) return { projects, complete: true };
    until = String(next);
  }
  return { projects, complete: false };
}

/** The client's sites. */
export async function listSites(db: ControlDb, client: AuthorizedClient): Promise<SiteRow[]> {
  assertAuthorizedClient(client);
  return db.select().from(site).where(eq(site.locationId, client.location.id));
}

/**
 * Makes an existing project on the agency's Vercel team this client's site, so a domain can be
 * attached to it. Owners and admins only. The project must be on the connected team, and one
 * project belongs to one client.
 */
export async function linkHostProject(
  deps: SiteDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { projectId: string },
): Promise<SiteRow> {
  assertAuthorizedClient(client);
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const grant = await hostGrant(deps, organizationId);
  // Asked with the agency's token, so a project on any other team is simply not found.
  const result = await vercel<{ id?: string; name?: string }>(
    deps,
    grant,
    "GET",
    projectPath(input.projectId),
  );
  if (result.status === 404) throw new ConnectError("That project isn't on your Vercel team.");
  if (!result.ok || !result.body.id) throw refused(result, "Vercel didn't find that project.");
  const projectId = result.body.id;

  // Vercel project ids are global: a project is one site, in any agency (a unique index too).
  const [taken] = await deps.db
    .select({ locationId: site.locationId })
    .from(site)
    .where(eq(site.hostProjectId, projectId));
  if (taken) throw alreadyLinked(taken.locationId === client.location.id);

  const [row] = await deps.db
    .insert(site)
    .values({
      id: randomUUID(),
      locationId: client.location.id,
      host: "vercel",
      hostProjectId: projectId,
      status: "deployed",
    })
    .returning()
    .catch((error: unknown) => {
      // Linked by a concurrent request between the check above and this insert.
      const text = `${error} ${(error as { cause?: unknown })?.cause ?? ""}`;
      if (/UNIQUE constraint failed/i.test(text)) {
        throw alreadyLinked(false);
      }
      throw error;
    });
  await audit(deps.db, ctx, client, "site.link", { projectId, name: result.body.name });
  // biome-ignore lint/style/noNonNullAssertion: an insert returns its row
  return row!;
}

const alreadyLinked = (here: boolean) =>
  new ConnectError(
    here ? "That project is already this client's site." : "That project is already another site.",
  );

async function clientSite(
  deps: SiteDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteRow & { hostProjectId: string }> {
  // Scoped to the client from the session, so another client's site looks like a missing one.
  const [row] = await deps.db
    .select()
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ConnectError("That site isn't one of this client's.");
  if (row.host !== "vercel" || !row.hostProjectId) {
    throw new ConnectError("This site isn't on Vercel yet.");
  }
  return { ...row, hostProjectId: row.hostProjectId };
}

/**
 * Adds a domain to the site's Vercel project and keeps it on the site. Owners and admins only.
 * A site has one custom domain; remove it to use another.
 */
export async function attachSiteDomain(
  deps: SiteDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string; domain: string },
): Promise<DomainStatus> {
  assertAuthorizedClient(client);
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const domain = normalizeDomain(input.domain);
  const row = await clientSite(deps, client, input.siteId);
  if (row.customDomain && row.customDomain !== domain) {
    throw new ConnectError(`This site already uses ${row.customDomain}. Remove it first.`);
  }
  const grant = await hostGrant(deps, organizationId);
  if (!row.customDomain) {
    const added = await vercel(
      deps,
      grant,
      "POST",
      `/v10/projects/${encodeURIComponent(row.hostProjectId)}/domains`,
      {
        body: { name: domain },
      },
    );
    if (!added.ok) {
      // Vercel refuses a domain that is already on this project, which is where we want it:
      // accept the refusal only if the project really has the domain.
      const path = projectPath(row.hostProjectId, `/domains/${encodeURIComponent(domain)}`);
      const existing = await vercel(deps, grant, "GET", path);
      if (!existing.ok) throw refused(added, "Vercel didn't add that domain. Try again.");
    }
    await deps.db.update(site).set({ customDomain: domain }).where(eq(site.id, row.id));
    await audit(deps.db, ctx, client, "site.domain.add", { siteId: row.id, domain });
  }
  return domainStatus(deps, grant, row.hostProjectId, domain);
}

/**
 * Where the site's domain stands, and the DNS records still missing. Asks Vercel to check the
 * verification record again first. Anyone who may work on the client may look.
 */
export async function siteDomainStatus(
  deps: SiteDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<DomainStatus | null> {
  assertAuthorizedClient(client);
  const row = await clientSite(deps, client, siteId);
  if (!row.customDomain) return null;
  const grant = await hostGrant(deps, client.location.organizationId);
  return domainStatus(deps, grant, row.hostProjectId, row.customDomain);
}

interface ProjectDomain {
  name?: string;
  apexName?: string;
  verified?: boolean;
  verification?: { type: string; domain: string; value: string }[];
}

async function domainStatus(
  deps: SiteDeps,
  grant: VercelGrant,
  projectId: string,
  domain: string,
): Promise<DomainStatus> {
  const path = projectPath(projectId, `/domains/${encodeURIComponent(domain)}`);
  const got = await vercel<ProjectDomain>(deps, grant, "GET", path);
  if (got.status === 404) {
    throw new ConnectError(`${domain} is no longer on this site's Vercel project. Remove it here.`);
  }
  if (!got.ok) throw refused(got, "Vercel didn't show the domain. Try again.");
  let current = got.body;
  if (!current.verified) {
    // A failed check is the normal answer until the TXT record is in place.
    const checked = await vercel<ProjectDomain>(deps, grant, "POST", `${path}/verify`);
    if (checked.ok) current = { ...current, ...checked.body };
  }
  const apex = current.apexName || domain;

  if (!current.verified) {
    const records = (current.verification ?? [])
      .filter((v) => v.type.toUpperCase() === "TXT")
      .map((v) => txtRecord(v.domain, v.value, apex));
    return { domain, state: "verify", records };
  }

  const config = await vercel<{
    misconfigured?: boolean;
    recommendedCNAME?: { rank: number; value: string }[];
    recommendedIPv4?: { rank: number; value: string[] }[];
  }>(deps, grant, "GET", `/v6/domains/${encodeURIComponent(domain)}/config`, {
    query: { projectIdOrName: projectId },
  });
  if (!config.ok) throw refused(config, "Vercel didn't check the domain's DNS. Try again.");
  if (config.body.misconfigured === false) return { domain, state: "live", records: [] };

  const best = <T extends { rank: number }>(list: T[] | undefined) =>
    [...(list ?? [])].sort((a, b) => a.rank - b.rank)[0];
  const record: DnsRecord =
    domain === apex
      ? {
          type: "A",
          name: "@",
          value: best(config.body.recommendedIPv4)?.value[0] ?? DEFAULT_IPV4,
          zone: apex,
          why: "point",
        }
      : {
          type: "CNAME",
          name: relativeName(domain, apex),
          value: (best(config.body.recommendedCNAME)?.value ?? DEFAULT_CNAME).replace(/\.$/, ""),
          zone: apex,
          why: "point",
        };
  return { domain, state: "point", records: [record] };
}

const relativeName = (name: string, apex: string) =>
  name === apex ? "@" : name.endsWith(`.${apex}`) ? name.slice(0, -(apex.length + 1)) : name;

const txtRecord = (name: string, value: string, apex: string): DnsRecord => ({
  type: "TXT",
  name: relativeName(name, apex),
  value,
  zone: apex,
  why: "verify",
});

/** Takes the domain off the site and its Vercel project. Owners and admins only. */
export async function removeSiteDomain(
  deps: SiteDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<void> {
  assertAuthorizedClient(client);
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const row = await clientSite(deps, client, siteId);
  if (!row.customDomain) return;
  const grant = await hostGrant(deps, organizationId);
  const path = projectPath(row.hostProjectId, `/domains/${encodeURIComponent(row.customDomain)}`);
  const removed = await vercel(deps, grant, "DELETE", path);
  // Already gone from Vercel: still take it off the site.
  if (!removed.ok && removed.status !== 404) {
    throw refused(removed, "Vercel didn't remove the domain. Try again.");
  }
  await deps.db.update(site).set({ customDomain: null }).where(eq(site.id, row.id));
  await audit(deps.db, ctx, client, "site.domain.remove", {
    siteId: row.id,
    domain: row.customDomain,
  });
}

/**
 * Takes a linked Vercel project off the client, e.g. after the project was deleted on Vercel.
 * Owners and admins only, and only once its domain is removed. Nothing changes on Vercel. A site
 * made only by linking is deleted; one with a repository keeps its row, without the project.
 */
export async function unlinkHostProject(
  deps: SiteDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<void> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  const [row] = await deps.db
    .select()
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ConnectError("That site isn't one of this client's.");
  if (!row.hostProjectId) throw new ConnectError("This site has no linked project.");
  if (row.customDomain) {
    throw new ConnectError(`Remove ${row.customDomain} from this site first.`);
  }
  // Still linked and still without a domain, so a domain added meanwhile is never orphaned.
  const unchanged = and(
    eq(site.id, row.id),
    eq(site.hostProjectId, row.hostProjectId),
    isNull(site.customDomain),
  );
  // TODO(site studio): a site made by Studio needs its own marker; "no repository" stands in.
  const changed = row.repoFullName
    ? await deps.db
        .update(site)
        .set({ host: null, hostProjectId: null, deployUrl: null, status: "pushed" })
        .where(unchanged)
        .returning({ id: site.id })
    : await deps.db.delete(site).where(unchanged).returning({ id: site.id });
  if (changed.length === 0) {
    throw new ConnectError("This site changed while you were unlinking it. Try again.");
  }
  await audit(deps.db, ctx, client, "site.unlink", {
    siteId: row.id,
    projectId: row.hostProjectId,
  });
}

/** The longest folder name the Sites page takes. */
export const MAX_FOLDER_LENGTH = 60;

/**
 * Files one of the client's sites under a folder on the Sites page, or under none when `folder`
 * is blank. A folder is just a name the client's sites share: it exists while a site is in it.
 * Anyone who may work on the client may file its sites, except on a site they may only view.
 */
export async function setSiteFolder(
  db: ControlDb,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string; folder: string },
): Promise<void> {
  assertAuthorizedClient(client);
  const folder = input.folder.trim().replace(/\s+/g, " ") || null;
  if (folder && folder.length > MAX_FOLDER_LENGTH) {
    throw new ConnectError(`Give the folder a name of up to ${MAX_FOLDER_LENGTH} characters.`);
  }
  if ((await siteAccessLevel(db, client, input.siteId)) === "view") {
    throw new ConnectError("You can view this site but not change it.");
  }
  const changed = await db
    .update(site)
    .set({ folder })
    .where(and(eq(site.id, input.siteId), eq(site.locationId, client.location.id)))
    .returning({ id: site.id });
  if (changed.length === 0) throw new ConnectError("That site isn't one of this client's.");
  await audit(db, ctx, client, "site.folder", { siteId: input.siteId, folder });
}

export async function audit(
  db: ControlDb,
  ctx: SessionContext,
  client: AuthorizedClient,
  action: string,
  detail: Record<string, unknown>,
) {
  await db.insert(auditLog).values({
    id: randomUUID(),
    organizationId: client.location.organizationId,
    actorUserId: ctx.userId,
    locationId: client.location.id,
    action,
    detail,
  });
}
