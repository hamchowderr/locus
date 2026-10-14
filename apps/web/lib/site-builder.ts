import { randomUUID } from "node:crypto";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  ClientAccessDenied,
  checkAllowance,
  mintClientDbToken,
  recordUsage,
  type SessionContext,
  type UsageMeasurement,
} from "@locus/auth";
import {
  type BuilderSession,
  type BuilderUsage,
  createSiteBuilderTools,
  type ImageGenerator,
  PublishError,
  type ResolveBuilderSession,
  SITE_BUILDER_MODE,
  type SiteBuilderTools,
  UntrustedOutputProcessor,
  type UsageMeter,
} from "@locus/builder";
import { ConnectError, commitSiteVersion, type PublishDeps } from "@locus/connect";
import { type ControlDb, openTenantDb, type TenantDb, type TenantProvisioner } from "@locus/db";
import { auditLog, site } from "@locus/db/control";
import type { RuntimeProvider } from "@locus/sandbox";
import {
  readBrief,
  SITE_KINDS,
  SiteWorkspace,
  startSite,
  templateById,
  type VersionInfo,
  WorkspaceError,
} from "@locus/studio";
import { and, eq } from "drizzle-orm";

// Host wiring for the site-builder agent. Everything here starts from an `AuthorizedClient`
// (the session's client, after the staff check) and never takes a client or agency id from a
// request, a form or the model. Environment-specific pieces (the control database, the
// provisioner, the sandbox provider, GitHub) come in as `SiteBuilderDeps`, so tests run on a
// temp database, the local provisioner, the fake runtime and the stub GitHub.

/** Request-context key the chat host sets to the site the conversation builds. */
export const SITE_ID_KEY = "siteId";
/**
 * Optional request-context key for the `AuthorizedClient` of the member making this request,
 * when one controller (and so one set of tools) serves several members of a client. It must be
 * for the same client the tools were made for.
 */
export const CLIENT_KEY = "locusClient";
/** Optional request-context key for the signed-in user, recorded as versions' author. */
export const USER_ID_KEY = "userId";

export interface SiteBuilderDeps {
  db: ControlDb;
  /** Opens one client's own database. Only ever called with an authorized client. */
  openClientDb: (client: AuthorizedClient) => Promise<TenantDb>;
  /** Sandboxes; the key is `siteRuntimeKey`. Throw from `open` when none is configured. */
  runtimes: () => RuntimeProvider;
  images?: ImageGenerator | null;
  /**
   * Publishing to the agency's GitHub. Null turns it off; a throw (e.g. not configured) is
   * reported to the person after the version is saved.
   */
  publish?: (() => PublishDeps) | null;
}

export interface SiteBuilderWiring {
  /** For `createLocusController({ modes })`. */
  modes: [typeof SITE_BUILDER_MODE];
  /** For `createLocusController({ tools })`. */
  tools: SiteBuilderTools;
  /**
   * For `createLocusController({ processors: { output } })`: screens reference pages, command
   * and build output on `processToolResult` (an `AgentControllerMode` can't carry processors).
   */
  processors: { output: [UntrustedOutputProcessor] };
  /** The resolver the tools use; exposed for hosts and tests. */
  resolve: ResolveBuilderSession;
}

const contextValue = (requestContext: unknown, key: string): unknown => {
  if (!requestContext || typeof requestContext !== "object") return undefined;
  const ctx = requestContext as { get?: (k: string) => unknown } & Record<string, unknown>;
  return typeof ctx.get === "function" ? ctx.get(key) : ctx[key];
};

/** The sandbox key for a site: stable across processes, one per client and site. */
export const siteRuntimeKey = (client: AuthorizedClient, siteId: string) =>
  `${client.location.id}/${siteId}`;

/**
 * The control `site` row for `siteId`, only if it is this client's. Refuses (403, saying no
 * more) a missing site and another client's site alike.
 */
export async function clientSite(db: ControlDb, client: AuthorizedClient, siteId: string) {
  assertAuthorizedClient(client);
  const [row] = siteId
    ? await db
        .select()
        .from(site)
        .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)))
    : [];
  if (!row) throw new ClientAccessDenied("site is not this client's");
  return row;
}

/** Builder usage in the units `@locus/auth` prices. */
export function toMeasurement(usage: BuilderUsage): UsageMeasurement {
  switch (usage.kind) {
    case "image":
      return { kind: "image", count: usage.count, size: usage.size };
    case "sandbox":
      return { kind: "sandbox", seconds: usage.seconds };
  }
}

/** The client's credits, checked before and recorded after sandbox work and images. */
export function usageMeter(
  db: ControlDb,
  client: AuthorizedClient,
  opts: { siteId?: string | null; userId?: string | null } = {},
): UsageMeter {
  return {
    async check() {
      const allowance = await checkAllowance(db, client);
      return allowance.ok ? { ok: true } : { ok: false, reason: allowance.reason };
    },
    async record(usage) {
      await recordUsage(db, client, {
        usage: toMeasurement(usage),
        siteId: opts.siteId ?? null,
        actorUserId: opts.userId ?? null,
      });
    },
  };
}

/**
 * Commits each saved version to the site's GitHub repository, once the site has one.
 *
 * A site without a repository is not published: the version is saved in the client's database
 * only, and nothing is created on GitHub or Vercel from the agent. Giving the site a repository
 * and a Vercel project (`ensureSiteRepo`, `ensureSiteDeployment`) is an owner's or admin's
 * decision taken outside the conversation; after that, each save commits and Vercel deploys
 * the push. Errors written for the person (`ConnectError`) reach the model as `PublishError`;
 * anything else stays generic.
 */
export function publishHook(
  db: ControlDb,
  publish: () => PublishDeps,
  client: AuthorizedClient,
  siteId: string,
): NonNullable<BuilderSession["onVersionSaved"]> {
  return async (version: VersionInfo, files) => {
    const row = await clientSite(db, client, siteId);
    if (!row.repoFullName) return undefined;
    try {
      const { commitSha, url } = await commitSiteVersion(publish(), client, {
        siteId,
        message: `Version ${version.number}: ${version.message}`,
        files: files.map(({ path, content }) => ({ path, content })),
      });
      return { commitSha, url };
    } catch (error) {
      if (error instanceof ConnectError) throw new PublishError(error.message);
      throw error;
    }
  };
}

/** Keeps one client database open for a while, then reopens it with a fresh token. */
function clientDbCache(deps: SiteBuilderDeps, client: AuthorizedClient) {
  const LIFETIME_MS = 45 * 60_000;
  let open: { db: Promise<TenantDb>; until: number } | undefined;
  return () => {
    const now = Date.now();
    if (!open || open.until <= now) {
      const previous = open;
      const db = deps.openClientDb(client);
      // A failed open is not kept.
      db.catch(() => {
        if (open?.db === db) open = undefined;
      });
      open = { db, until: now + LIFETIME_MS };
      // Calls still using the old connection get a minute to finish.
      if (previous) {
        setTimeout(() => {
          previous.db.then((d) => d.$client.close()).catch(() => {});
        }, 60_000).unref?.();
      }
    }
    return open.db;
  };
}

/**
 * The site builder for one client: its controller mode, tools and output processor.
 *
 * `client` is the session's client from `resolveActiveClient` (the staff check has run). On
 * every tool call `resolve` reads the site id the host set in the request context
 * (`SITE_ID_KEY`), checks the site is this client's in the control database before opening
 * anything, then opens this client's database, its sandbox, images, the credit meter and
 * publishing. A host that shares the tools between members passes each request's own
 * `AuthorizedClient` under `CLIENT_KEY`; it must be for the same client.
 */
export function createSiteBuilder(
  deps: SiteBuilderDeps,
  input: { client: AuthorizedClient; userId?: string | null },
): SiteBuilderWiring {
  const bound = input.client;
  assertAuthorizedClient(bound);
  const clientDb = clientDbCache(deps, bound);

  const resolve: ResolveBuilderSession = async (requestContext) => {
    const siteId = contextValue(requestContext, SITE_ID_KEY);
    if (typeof siteId !== "string" || !siteId) {
      throw new ClientAccessDenied("no site in the request context");
    }
    const given = contextValue(requestContext, CLIENT_KEY) as AuthorizedClient | undefined;
    const client = given ?? bound;
    assertAuthorizedClient(client);
    if (client.location.id !== bound.location.id) {
      throw new ClientAccessDenied("request is for another client");
    }
    const contextUser = contextValue(requestContext, USER_ID_KEY);
    const userId = typeof contextUser === "string" ? contextUser : (input.userId ?? null);

    await clientSite(deps.db, client, siteId);
    const workspace = new SiteWorkspace(await clientDb(), siteId);
    return {
      workspace,
      runtime: () => deps.runtimes().open(siteRuntimeKey(client, siteId)),
      images: deps.images ?? null,
      meter: usageMeter(deps.db, client, { siteId, userId }),
      userId,
      ...(deps.publish
        ? { onVersionSaved: publishHook(deps.db, deps.publish, client, siteId) }
        : {}),
    };
  };

  return {
    modes: [SITE_BUILDER_MODE],
    tools: createSiteBuilderTools({ resolve }),
    processors: { output: [new UntrustedOutputProcessor()] },
    resolve,
  };
}

/** The httpOnly cookie the Sites page sets to the site a member chose to build. */
export const ACTIVE_SITE_COOKIE = "locus_site";

/** A cookie's value from a `Cookie` header, or null. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The site the request's member chose on the Sites page (`ACTIVE_SITE_COOKIE`), only if it is a
 * site of `locationId` — the client the host resolved from the session, never from the request.
 * Null otherwise. The cookie only names a site; this check is what makes it trustworthy, and
 * `resolve` checks again on every tool call.
 */
export async function activeSiteIdFor(
  db: ControlDb,
  request: Pick<Request, "headers">,
  locationId: string,
): Promise<string | null> {
  const siteId = cookieValue(request.headers.get("cookie"), ACTIVE_SITE_COOKIE);
  if (!siteId || !locationId) return null;
  const [row] = await db
    .select({ id: site.id })
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, locationId)));
  return row?.id ?? null;
}

/** One client's database, with a token that names only it, minted after the staff check. */
export async function openClientDb(
  provisioner: TenantProvisioner,
  client: AuthorizedClient,
): Promise<TenantDb> {
  const token = await mintClientDbToken(provisioner, client, { ttl: "1h" });
  return openTenantDb(provisioner.url(client.location.tursoDbHostname), token);
}

export type SiteKind = (typeof SITE_KINDS)[number];

export interface NewSite {
  name: string;
  kind: string;
  /** Empty means the template that fits the kind. */
  templateId?: string;
}

/** A site the person can fix by changing the form. */
export class SiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInputError";
  }
}

/**
 * Creates a site for the session's client and starts it from a template, so version 1 exists:
 * the control `site` row (the client from `client`, never from the form), then the brief and
 * the template's files in the client's own database. If starting fails the row is removed.
 * Anyone who may work on the client may create one; giving it a repository or Vercel project
 * stays with owners and admins.
 */
export async function createClientSite(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb">,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: NewSite,
): Promise<{ siteId: string; version: VersionInfo }> {
  assertAuthorizedClient(client);
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new SiteInputError("Give the site a name of up to 120 characters.");
  }
  if (!(SITE_KINDS as readonly string[]).includes(input.kind)) {
    throw new SiteInputError("Pick what kind of site it is.");
  }
  const templateId = input.templateId?.trim() || undefined;
  if (templateId && !templateById(templateId)) {
    throw new SiteInputError("Pick one of the templates.");
  }

  const siteId = randomUUID();
  await deps.db.insert(site).values({ id: siteId, locationId: client.location.id });
  let version: VersionInfo;
  try {
    const tenant = await deps.openClientDb(client);
    try {
      ({ version } = await startSite(new SiteWorkspace(tenant, siteId), {
        brief: { name, kind: input.kind as SiteKind },
        ...(templateId ? { templateId } : {}),
        userId: ctx.userId,
      }));
    } finally {
      tenant.$client.close();
    }
  } catch (error) {
    await deps.db.delete(site).where(eq(site.id, siteId));
    if (error instanceof WorkspaceError) throw new SiteInputError(error.message);
    throw error;
  }
  await deps.db.insert(auditLog).values({
    id: randomUUID(),
    organizationId: client.location.organizationId,
    actorUserId: ctx.userId,
    locationId: client.location.id,
    action: "site.create",
    detail: { siteId, templateId: templateId ?? null },
  });
  return { siteId, version };
}

/** The sites' names from their briefs in the client's database, by site id. */
export async function siteNames(
  deps: Pick<SiteBuilderDeps, "openClientDb">,
  client: AuthorizedClient,
  siteIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (siteIds.length === 0) return names;
  const tenant = await deps.openClientDb(client);
  try {
    for (const id of siteIds) {
      const brief = await readBrief(tenant, id);
      if (brief) names.set(id, brief.name);
    }
  } finally {
    tenant.$client.close();
  }
  return names;
}
