import { randomUUID } from "node:crypto";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
  siteAccessLevel,
} from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { auditLog, site, siteBackend, siteFolder } from "@locus/db/control";
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

/** Where one domain on the site's project stands, and the DNS records still missing. */
export interface DomainState {
  domain: string;
  /**
   * `verify`: Vercel needs the TXT record before it will use the domain on this project.
   * `point`: verified, but the domain doesn't reach Vercel yet (or has no certificate yet).
   * `live`: serving this site.
   */
  state: "verify" | "point" | "live";
  records: DnsRecord[];
}

export interface DomainStatus extends DomainState {
  /**
   * The other half of an apex/www pair (example.com for www.example.com, and the reverse),
   * when it is on the project sending visitors to `domain`.
   */
  redirect?: DomainState;
  /** That other half, when it isn't on the project yet and Locus can add it. */
  partner?: string;
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

/**
 * The other half of an apex/www pair: `www.example.com` for `example.com` and the reverse.
 * Null for any other name (`shop.example.com`), which stands alone.
 */
export function pairedDomain(domain: string, apex: string): string | null {
  if (domain === apex) return `www.${apex}`;
  if (domain === `www.${apex}`) return apex;
  return null;
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

/** A client's site as the Sites page lists it, with the folder it is filed under. */
export type ListedSite = SiteRow & { folder: string | null };

/** The client's sites. */
export async function listSites(db: ControlDb, client: AuthorizedClient): Promise<ListedSite[]> {
  assertAuthorizedClient(client);
  const rows = await db
    .select({ site, folder: siteFolder.name })
    .from(site)
    .leftJoin(siteFolder, eq(siteFolder.siteId, site.id))
    .where(eq(site.locationId, client.location.id));
  return rows.map((r) => ({ ...r.site, folder: r.folder }));
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
 * Adds a domain to the site's Vercel project and keeps it on the site, with its apex/www
 * partner sending visitors to it (`pairedDomain`). Owners and admins only. A site has one
 * custom domain; remove it to use another. Asking again for the site's own domain adds a
 * partner that is still missing, and says why if Vercel refuses it; on the first add, a
 * refused partner is only offered again (`DomainStatus.partner`).
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
      const existing = await vercel<ProjectDomain>(deps, grant, "GET", path);
      if (!existing.ok) throw refused(added, "Vercel didn't add that domain. Try again.");
      // Already there only to send visitors elsewhere: that other domain is the site's.
      const elsewhere = existing.body.redirect;
      if (elsewhere) {
        throw new ConnectError(
          `${domain} already sends visitors to ${elsewhere}. Connect ${elsewhere} instead.`,
        );
      }
    }
    await deps.db.update(site).set({ customDomain: domain }).where(eq(site.id, row.id));
    await audit(deps.db, ctx, client, "site.domain.add", { siteId: row.id, domain });
  }
  const partner = await addPartner(deps, grant, row.hostProjectId, domain);
  if (partner.added) {
    await audit(deps.db, ctx, client, "site.domain.add", {
      siteId: row.id,
      domain: partner.added,
      redirectTo: domain,
    });
  }
  // Asked again for its own domain: the person wants the partner, so say why it wasn't added.
  if (partner.refused && row.customDomain === domain) throw partner.refused;
  return domainStatus(deps, grant, row.hostProjectId, domain);
}

/**
 * Puts the domain's apex/www partner on the project, sending visitors to the domain with a
 * permanent redirect (308). Leaves alone a partner already on the project, whatever it does.
 */
async function addPartner(
  deps: SiteDeps,
  grant: VercelGrant,
  projectId: string,
  domain: string,
): Promise<{ added?: string; refused?: ConnectError }> {
  let partner: string | null;
  try {
    partner = partnerOf(domain, await projectDomain(deps, grant, projectId, domain));
    if (!partner || (await projectDomain(deps, grant, projectId, partner))) return {};
  } catch (error) {
    // Vercel didn't answer about the pair: the domain itself is attached all the same.
    if (error instanceof ConnectError) return { refused: error };
    throw error;
  }
  const added = await vercel(
    deps,
    grant,
    "POST",
    `/v10/projects/${encodeURIComponent(projectId)}/domains`,
    { body: { name: partner, redirect: domain, redirectStatusCode: 308 } },
  );
  if (added.status === 403 || added.status === 409) {
    // Vercel's "you don't have access to the domain" or "already in use", not our connection.
    const why = added.body.error?.message;
    return {
      refused: new ConnectError(
        `Vercel didn't add ${partner}: it's on another Vercel project or account.${why ? ` (${why})` : ""}`,
      ),
    };
  }
  if (!added.ok) {
    return { refused: refused(added, `Vercel didn't add ${partner}. Try again.`) };
  }
  return { added: partner };
}

/** The domain's apex/www partner, going by the apex Vercel gives for it. */
const partnerOf = (domain: string, found: ProjectDomain | null) =>
  found?.apexName ? pairedDomain(domain, found.apexName) : null;

/** The domain as the project has it; null when it isn't on the project. */
async function projectDomain(
  deps: SiteDeps,
  grant: VercelGrant,
  projectId: string,
  domain: string,
): Promise<ProjectDomain | null> {
  const path = projectPath(projectId, `/domains/${encodeURIComponent(domain)}`);
  const got = await vercel<ProjectDomain>(deps, grant, "GET", path);
  if (got.status === 404) return null;
  if (!got.ok) throw refused(got, "Vercel didn't show the domain. Try again.");
  return got.body;
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
  /** Where the domain sends visitors, when it redirects. */
  redirect?: string | null;
  verified?: boolean;
  verification?: { type: string; domain: string; value: string }[];
}

/** The site's domain, with its apex/www partner: redirecting to it, or still to add. */
async function domainStatus(
  deps: SiteDeps,
  grant: VercelGrant,
  projectId: string,
  domain: string,
): Promise<DomainStatus> {
  const current = await projectDomain(deps, grant, projectId, domain);
  if (!current) {
    throw new ConnectError(`${domain} is no longer on this site's Vercel project. Remove it here.`);
  }
  const status: DomainStatus = await domainState(deps, grant, projectId, domain, current);
  const partner = partnerOf(domain, current);
  if (!partner) return status;
  try {
    const other = await projectDomain(deps, grant, projectId, partner);
    if (!other) return { ...status, partner };
    // On the project but serving something else (another site's address, say): not this pair's.
    if (other.redirect !== domain) return status;
    return { ...status, redirect: await domainState(deps, grant, projectId, partner, other) };
  } catch (error) {
    // The pair is extra: a failed lookup leaves the domain's own status standing.
    if (error instanceof ConnectError) return status;
    throw error;
  }
}

async function domainState(
  deps: SiteDeps,
  grant: VercelGrant,
  projectId: string,
  domain: string,
  found: ProjectDomain,
): Promise<DomainState> {
  const path = projectPath(projectId, `/domains/${encodeURIComponent(domain)}`);
  let current = found;
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
  // Its partner first, but only one Locus would have added: redirecting to this domain.
  const primary = await projectDomain(deps, grant, row.hostProjectId, row.customDomain);
  // Gone from the project already: the partner is still found by its name alone.
  const partner = primary
    ? partnerOf(row.customDomain, primary)
    : row.customDomain.startsWith("www.")
      ? row.customDomain.slice(4)
      : `www.${row.customDomain}`;
  const other = partner ? await projectDomain(deps, grant, row.hostProjectId, partner) : null;
  if (partner && other?.redirect === row.customDomain) {
    const gone = await vercel(
      deps,
      grant,
      "DELETE",
      projectPath(row.hostProjectId, `/domains/${encodeURIComponent(partner)}`),
    );
    if (!gone.ok && gone.status !== 404) {
      throw refused(gone, `Vercel didn't remove ${partner}. Try again.`);
    }
    await audit(deps.db, ctx, client, "site.domain.remove", {
      siteId: row.id,
      domain: partner,
      redirectTo: row.customDomain,
    });
  }
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
  // A site with its own database keeps its row (and so its database): unlinking the project
  // must not delete the site's records.
  const [backend] = await deps.db
    .select({ siteId: siteBackend.siteId })
    .from(siteBackend)
    .where(eq(siteBackend.siteId, row.id));
  // TODO(site studio): a site made by Studio needs its own marker; "no repository" stands in.
  const changed =
    row.repoFullName || backend
      ? await deps.db
          .update(site)
          .set({
            host: null,
            hostProjectId: null,
            deployUrl: null,
            status: row.repoFullName ? "pushed" : "draft",
          })
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
  const [row] = await db
    .select({ id: site.id })
    .from(site)
    .where(and(eq(site.id, input.siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ConnectError("That site isn't one of this client's.");
  if (folder) {
    await db
      .insert(siteFolder)
      .values({ siteId: row.id, name: folder })
      .onConflictDoUpdate({ target: siteFolder.siteId, set: { name: folder } });
  } else {
    await db.delete(siteFolder).where(eq(siteFolder.siteId, row.id));
  }
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
