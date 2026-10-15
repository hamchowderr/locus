import { randomUUID } from "node:crypto";
import {
  type AuthorizedClient,
  agencyEntitlement,
  agentToWebKey,
  assertAuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  checkAllowance,
  mintAgentToWebToken,
  mintClientDbToken,
  monthOf,
  recordUsage,
  type SessionContext,
  type UsageMeasurement,
} from "@locus/auth";
import { ConnectError, commitSiteVersion, type PublishDeps } from "@locus/connect";
import { type ControlDb, openTenantDb, type TenantDb, type TenantProvisioner } from "@locus/db";
import { auditLog, member, session, site } from "@locus/db/control";
import { siteBrief, siteDraftFile, siteVersion, siteVersionFile } from "@locus/db/tenant";
import {
  FakeRuntimeProvider,
  RemoteRuntimeProvider,
  type RuntimeProvider,
  SANDBOX_RPC_PATH,
  type SiteRuntime,
  sandboxFromEnv,
} from "@locus/sandbox";
import {
  readBrief,
  SITE_KINDS,
  SiteWorkspace,
  startSite,
  templateById,
  type VersionInfo,
  WorkspaceError,
  withLocusSettings,
} from "@locus/studio";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import {
  BuilderError,
  type BuilderSession,
  type BuilderUsage,
  createSiteBuilderTools,
  type ImageGenerator,
  PublishError,
  type ResolveBuilderSession,
  SITE_BUILDER_MODE,
  SITE_BUILDER_OWN_TEXT_TOOLS,
  type SiteBuilderTools,
  UntrustedOutputProcessor,
  type UsageMeter,
} from "./index.ts";

// Host wiring for the site-builder agent. Everything here starts from an `AuthorizedClient`
// (the session's client, after the staff check) and never takes a client or agency id from a
// request, a form or the model. Environment-specific pieces (the control database, the
// provisioner, the sandbox provider, GitHub) come in as `SiteBuilderDeps`, so tests run on a
// temp database, the local provisioner, the fake runtime and the stub GitHub.

/**
 * Request-context key for the site the conversation builds. The host sets it on every run
 * from its own hook (`resolveActiveSiteId`), overwriting anything the browser sent.
 */
export const SITE_ID_KEY = "siteId";
/**
 * Optional request-context key for the `AuthorizedClient` of the member making this request,
 * when one controller (and so one set of tools) serves several members of a client. Set by the
 * host only, overwriting anything the browser sent; it must be for the same client.
 */
export const CLIENT_KEY = "locusClient";

export interface SiteBuilderDeps {
  db: ControlDb;
  /** Opens one client's own database. Only ever called with a freshly authorized client. */
  openClientDb: (client: AuthorizedClient) => Promise<TenantDb>;
  /** Sandboxes; the key is `siteRuntimeKey`. */
  runtimes: () => RuntimeProvider;
  /**
   * Opens a site's sandbox for the member behind `client` (freshly authorized), instead of
   * `runtimes`. For a host off Vercel: `remoteSiteRuntimes` drives them through the web app.
   */
  openRuntime?: (client: AuthorizedClient, siteId: string) => Promise<SiteRuntime>;
  images?: ImageGenerator | null;
  /**
   * Publishing to the agency's GitHub. Null turns it off; a throw (e.g. not configured) is
   * reported to the person after the version is saved.
   */
  publish?: (() => PublishDeps) | null;
  /**
   * This deployment's public address. Each published version gets `lib/locus.ts` pointing the
   * site's form route at `<locusUrl>/api/sites/<siteId>/leads` (`withLocusSettings`).
   */
  locusUrl: string;
  /** Billing is on: creating a site needs a plan, within its `sitesPerMonth`. */
  billing?: boolean;
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
  /** For `createLocusController({ ownTextTools })`: the skill tools, which return Locus's text. */
  ownTextTools: typeof SITE_BUILDER_OWN_TEXT_TOOLS;
  /** The resolver the tools use; exposed for hosts and tests. */
  resolve: ResolveBuilderSession;
  /** Closes this client's pooled database connection once no call is using it. */
  close: () => void;
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

/**
 * Runs the staff check again for the member behind `client`, now: membership, the member's
 * client list and the client's status may all have changed since it was authorized. Returns a
 * fresh `AuthorizedClient` and the member's user id. The agency and user come from the member
 * row, never from a request.
 */
export async function reauthorize(
  db: ControlDb,
  client: AuthorizedClient,
): Promise<{ client: AuthorizedClient; userId: string }> {
  assertAuthorizedClient(client);
  const [row] = await db
    .select({ userId: member.userId, organizationId: member.organizationId })
    .from(member)
    .where(eq(member.id, client.memberId));
  if (!row) throw new ClientAccessDenied("no longer a member of the agency");
  const ctx: SessionContext = {
    id: "site-builder",
    userId: row.userId,
    activeOrganizationId: row.organizationId,
  };
  return { client: await authorizeClient(db, ctx, client.location.id), userId: row.userId };
}

/** Builder usage in the units `@locus/auth` prices; an image keeps its model in the detail. */
export function toMeasurement(usage: BuilderUsage): UsageMeasurement {
  switch (usage.kind) {
    case "image": {
      const measurement = {
        kind: "image" as const,
        count: usage.count,
        size: usage.size,
        model: usage.model,
      };
      return measurement;
    }
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
 * Publishing refusals Locus itself writes for the person, which may reach the model. Anything
 * else (notably `GitHub: <GitHub's own text>`) is logged and replaced by a generic message.
 */
const PERSON_FACING_PUBLISH_ERRORS: RegExp[] = [
  /^Give the site a GitHub repository first\.$/,
  /^Connect GitHub on the Connections page first\.$/,
  /^The Locus GitHub app is no longer installed\. Connect GitHub again\.$/,
  /^GitHub refused\. Check on GitHub that the Locus app is still installed and has access to the site's repository\.$/,
  /^Locus can't reach [\w.-]+\/[\w.-]+ on GitHub\. Check that the Locus app has access to it\.$/,
  /^The site's repository changed (since this version was started|while saving)\. Reload (it|the site) and save again\.$/,
  /^GitHub didn't [\w ',.]+\.( Try again\.)?$/,
  /^Publishing to GitHub isn't set up on this deployment yet\.$/,
  /^There are no files to publish\.$/,
  /^That site isn't one of this client's\.$/,
  /^GitHub didn't create [\w.-]+\/[\w.-]+: the name is taken or not allowed\. Pick another, or link the existing repository\.$/,
  // Locus's own path checks; the path is one the agent wrote.
  /^Locus won't publish the file "[^"\n]{1,300}": the path isn't allowed\.$/,
  /^Locus won't publish "[^"\n]{1,300}": environment files can hold secrets and never go in the repository\.$/,
  /^"[^"\n]{1,300}" is in the version twice\.$/,
];

const GENERIC_PUBLISH_ERROR =
  "The version is saved, but GitHub refused it. Check that the Locus app can still reach the " +
  "site's repository, then save again.";

/** The message the model may see for a publishing refusal. */
export function publishMessage(error: ConnectError): string {
  if (PERSON_FACING_PUBLISH_ERRORS.some((pattern) => pattern.test(error.message))) {
    return error.message;
  }
  console.error(`Publishing a site version failed: ${error.message}`);
  return GENERIC_PUBLISH_ERROR;
}

/**
 * Commits each saved version to the site's GitHub repository, once the site has one.
 *
 * A site without a repository is not published: the version is saved in the client's database
 * only, and nothing is created on GitHub or Vercel from the agent. Giving the site a repository
 * and a Vercel project (`ensureSiteRepo`, `ensureSiteDeployment`) is an owner's or admin's
 * decision taken outside the conversation; after that, each save commits and Vercel deploys
 * the push. Only Locus's own refusals reach the model, as `PublishError` (`publishMessage`).
 */
export function publishHook(
  db: ControlDb,
  publish: () => PublishDeps,
  client: AuthorizedClient,
  siteId: string,
  locusUrl: string,
): NonNullable<BuilderSession["onVersionSaved"]> {
  return async (version: VersionInfo, files) => {
    const row = await clientSite(db, client, siteId);
    if (!row.repoFullName) return undefined;
    try {
      const { commitSha, url } = await commitSiteVersion(publish(), client, {
        siteId,
        message: `Version ${version.number}: ${version.message}`,
        // The version's files, with this site's form endpoint in `lib/locus.ts`.
        files: withLocusSettings(
          files.map(({ path, content }) => ({ path, content })),
          { siteId, locusUrl },
        ),
      });
      return { commitSha, url };
    } catch (error) {
      if (error instanceof ConnectError) throw new PublishError(publishMessage(error));
      throw error;
    }
  };
}

// One pooled connection per client database, shared by every builder in the process. It is
// replaced (with a freshly minted token) before the token's hour is up, and a replaced or
// closed connection is closed only once no call is still using it.

interface PooledDb {
  db: Promise<TenantDb>;
  until: number;
  users: number;
  retired: boolean;
}

const POOL_LIFETIME_MS = 45 * 60_000;
const pool = new Map<string, PooledDb>();

function closeIfIdle(entry: PooledDb) {
  if (!entry.retired || entry.users > 0) return;
  entry.db.then((db) => db.$client.close()).catch(() => {});
}

function retire(locationId: string) {
  const entry = pool.get(locationId);
  if (!entry) return;
  pool.delete(locationId);
  entry.retired = true;
  closeIfIdle(entry);
}

/** Closes pooled client connections (one client's, or all), each once it is idle. */
export function closeClientDbs(locationId?: string): void {
  for (const id of locationId ? [locationId] : [...pool.keys()]) retire(id);
}

/**
 * Borrows the client's pooled database connection; call `release` when done. Opens one with
 * `open(client)` when there is none or the current one is due for a fresh token, so pass a
 * client authorized just now.
 */
export async function leaseClientDb(
  open: (client: AuthorizedClient) => Promise<TenantDb>,
  client: AuthorizedClient,
  now = Date.now(),
): Promise<{ db: TenantDb; release: () => void }> {
  assertAuthorizedClient(client);
  const id = client.location.id;
  let entry = pool.get(id);
  if (entry && entry.until <= now) {
    retire(id);
    entry = undefined;
  }
  if (!entry) {
    entry = { db: open(client), until: now + POOL_LIFETIME_MS, users: 0, retired: false };
    pool.set(id, entry);
  }
  const leased = entry;
  leased.users++;
  let db: TenantDb;
  try {
    db = await leased.db;
  } catch (error) {
    leased.users--;
    if (pool.get(id) === leased) pool.delete(id);
    throw error;
  }
  let released = false;
  return {
    db,
    release: () => {
      if (released) return;
      released = true;
      leased.users--;
      closeIfIdle(leased);
    },
  };
}

/** How many calls are using the client's current pooled connection; for tests. */
export const pooledUsers = (locationId: string) => pool.get(locationId)?.users ?? null;

/**
 * Site sandboxes from the environment: Vercel Sandbox with `LOCUS_SANDBOX_TOKEN`,
 * `LOCUS_SANDBOX_TEAM_ID` and `LOCUS_SANDBOX_PROJECT_ID`, or on a Vercel deployment with its own
 * OIDC token (see `sandboxFromEnv`); otherwise the in-memory fake outside
 * production (commands succeed and run nothing, like the other stubs). In production without
 * them, sandbox tools answer that previews aren't set up; the setting names go to the log only.
 */
export function runtimesFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeProvider {
  const vercel = sandboxFromEnv(env);
  if (vercel) return vercel;
  if (env.NODE_ENV !== "production") return new FakeRuntimeProvider();
  return {
    async open() {
      console.error(
        "Locus is not configured: no Vercel OIDC token, and LOCUS_SANDBOX_TOKEN, LOCUS_SANDBOX_TEAM_ID or LOCUS_SANDBOX_PROJECT_ID is not set",
      );
      throw new BuilderError("Site previews aren't set up on this deployment.");
    },
  };
}

/**
 * Sandboxes driven through the web app's `/api/internal/sandbox` (see `RemoteRuntimeProvider`),
 * for `SiteBuilderDeps.openRuntime` on a host off Vercel. Each call carries a short-lived token
 * naming the member and client, so the web app runs the staff check itself; no credential for
 * Vercel leaves it.
 */
export function remoteSiteRuntimes(options: {
  /** The web app's base URL. */
  url: string;
  /** `BETTER_AUTH_SECRET`, shared with the web app. */
  authSecret: string;
  fetch?: typeof fetch;
}): (client: AuthorizedClient, siteId: string) => Promise<SiteRuntime> {
  const key = agentToWebKey(options.authSecret);
  const url = `${options.url.replace(/\/+$/, "")}${SANDBOX_RPC_PATH}`;
  return (client, siteId) => {
    assertAuthorizedClient(client);
    return new RemoteRuntimeProvider({
      url,
      mintToken: () =>
        mintAgentToWebToken(key, {
          memberId: client.memberId,
          locationId: client.location.id,
          organizationId: client.location.organizationId,
        }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }).open(siteId);
  };
}

/**
 * The site builder for one client: its controller mode, tools and output processor.
 *
 * `client` is the session's client from `resolveActiveClient`. On every tool call `resolve`:
 * reads the site id the host set (`SITE_ID_KEY`); takes the request's member from `CLIENT_KEY`
 * (it must be for this same client) or else `client`'s; runs the staff check again for that
 * member, so removed access stops the next call; checks the site is this client's in the
 * control database; and only then borrows the client's database connection and builds the
 * session. The member's user id comes from the control database, never from the request.
 */
export function createSiteBuilder(
  deps: SiteBuilderDeps,
  input: {
    client: AuthorizedClient;
    /**
     * The member making this run, for a host whose request context is serialized (so
     * `CLIENT_KEY` can't carry an `AuthorizedClient`): e.g. the staff check for the run's own
     * session. It must be for `client`'s client; it is checked again either way.
     */
    requester?: (requestContext: unknown) => Promise<AuthorizedClient>;
  },
): SiteBuilderWiring {
  const bound = input.client;
  assertAuthorizedClient(bound);

  const resolve: ResolveBuilderSession = async (requestContext) => {
    const siteId = contextValue(requestContext, SITE_ID_KEY);
    if (typeof siteId !== "string" || !siteId) {
      throw new ClientAccessDenied("no site in the request context");
    }
    const given = input.requester
      ? await input.requester(requestContext)
      : (contextValue(requestContext, CLIENT_KEY) as AuthorizedClient | undefined);
    const requester = given ?? bound;
    assertAuthorizedClient(requester);
    if (requester.location.id !== bound.location.id) {
      throw new ClientAccessDenied("request is for another client");
    }
    const { client, userId } = await reauthorize(deps.db, requester);
    await clientSite(deps.db, client, siteId);
    const lease = await leaseClientDb(deps.openClientDb, client);
    return {
      workspace: new SiteWorkspace(lease.db, siteId),
      release: lease.release,
      runtime: () =>
        deps.openRuntime
          ? deps.openRuntime(client, siteId)
          : deps.runtimes().open(siteRuntimeKey(client, siteId)),
      images: deps.images ?? null,
      meter: usageMeter(deps.db, client, { siteId, userId }),
      userId,
      ...(deps.publish
        ? { onVersionSaved: publishHook(deps.db, deps.publish, client, siteId, deps.locusUrl) }
        : {}),
    };
  };

  return {
    modes: [SITE_BUILDER_MODE],
    tools: createSiteBuilderTools({ resolve }),
    processors: { output: [new UntrustedOutputProcessor()] },
    ownTextTools: SITE_BUILDER_OWN_TEXT_TOOLS,
    resolve,
    close: () => closeClientDbs(bound.location.id),
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
 * site of `client` (authorized from the session). Null otherwise. The cookie only names a site;
 * this check is what makes it trustworthy, and `resolve` checks again on every tool call.
 */
export async function activeSiteIdFor(
  db: ControlDb,
  request: Pick<Request, "headers">,
  client: AuthorizedClient,
): Promise<string | null> {
  assertAuthorizedClient(client);
  const siteId = cookieValue(request.headers.get("cookie"), ACTIVE_SITE_COOKIE);
  if (!siteId) return null;
  try {
    return (await clientSite(db, client, siteId)).id;
  } catch (error) {
    if (error instanceof ClientAccessDenied) return null;
    throw error;
  }
}

/**
 * Records `siteId` as the site the builder works on for this signed-in session, after checking
 * it is `client`'s (a refused site throws `ClientAccessDenied`). The agent server, which gets no
 * cookies, reads it back with `activeSiteIdForSession`.
 */
export async function chooseActiveSite(
  db: ControlDb,
  ctx: Pick<SessionContext, "id">,
  client: AuthorizedClient,
  siteId: string,
): Promise<string> {
  const row = await clientSite(db, client, siteId);
  await db.update(session).set({ activeSiteId: row.id }).where(eq(session.id, ctx.id));
  return row.id;
}

/**
 * The site this session chose (`chooseActiveSite`), only if it is still a site of `client`
 * (authorized for that session). Null otherwise.
 */
export async function activeSiteIdForSession(
  db: ControlDb,
  ctx: Pick<SessionContext, "id">,
  client: AuthorizedClient,
): Promise<string | null> {
  assertAuthorizedClient(client);
  const [row] = await db
    .select({ activeSiteId: session.activeSiteId })
    .from(session)
    .where(eq(session.id, ctx.id));
  if (!row?.activeSiteId) return null;
  try {
    return (await clientSite(db, client, row.activeSiteId)).id;
  } catch (error) {
    if (error instanceof ClientAccessDenied) return null;
    throw error;
  }
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

/** Why the agency may not create another site this month, or null. Soft by concurrent creates. */
export async function newSiteRefusal(
  db: ControlDb,
  organizationId: string,
  now = new Date(),
): Promise<string | null> {
  const entitlement = await agencyEntitlement(db, organizationId);
  if (!entitlement.entitled) {
    return entitlement.status === "past_due" || entitlement.status === "unpaid"
      ? "Your Locus payment is overdue. Update it on the Billing page to create sites."
      : "Choose a Locus plan on the Billing page to create sites.";
  }
  const cap = entitlement.limits?.sitesPerMonth;
  if (cap == null) return null;
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.organizationId, organizationId),
        eq(auditLog.action, "site.create"),
        gte(auditLog.createdAt, monthOf(now).start),
      ),
    );
  if ((row?.n ?? 0) < cap) return null;
  return `Your ${entitlement.plan?.title ?? ""} plan covers ${cap} new sites a month. Upgrade on the Billing page, or wait for next month.`;
}

/** Best effort: removes whatever a failed start left of a site in the client's database. */
async function forgetSiteFiles(tenant: TenantDb, siteId: string) {
  try {
    const versions = tenant
      .select({ id: siteVersion.id })
      .from(siteVersion)
      .where(eq(siteVersion.siteId, siteId));
    await tenant.batch([
      tenant.delete(siteVersionFile).where(inArray(siteVersionFile.versionId, versions)),
      tenant.delete(siteVersion).where(eq(siteVersion.siteId, siteId)),
      tenant.delete(siteDraftFile).where(eq(siteDraftFile.siteId, siteId)),
      tenant.delete(siteBrief).where(eq(siteBrief.siteId, siteId)),
    ]);
  } catch (error) {
    console.error(`Couldn't clean up after a failed site start: ${(error as Error).message}`);
  }
}

/**
 * Creates a site for the session's client and starts it from a template, so version 1 exists:
 * the control `site` row and its audit entry together (the client from `client`, never from
 * the form), then the brief and the template's files in the client's own database. If starting
 * fails, the row, the audit entry and what was written in the client's database are removed.
 * Anyone who may work on the client may create one, within the agency's plan when billing is
 * on; giving it a repository or Vercel project stays with owners and admins.
 */
export async function createClientSite(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb" | "billing">,
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
  if (deps.billing) {
    const refusal = await newSiteRefusal(deps.db, client.location.organizationId);
    if (refusal) throw new SiteInputError(refusal);
  }

  const siteId = randomUUID();
  const auditId = randomUUID();
  await deps.db.batch([
    deps.db.insert(site).values({ id: siteId, locationId: client.location.id }),
    deps.db.insert(auditLog).values({
      id: auditId,
      organizationId: client.location.organizationId,
      actorUserId: ctx.userId,
      locationId: client.location.id,
      action: "site.create",
      detail: { siteId, templateId: templateId ?? null },
    }),
  ]);
  let tenant: TenantDb | undefined;
  let release: (() => void) | undefined;
  try {
    ({ db: tenant, release } = await leaseClientDb(deps.openClientDb, client));
    const { version } = await startSite(new SiteWorkspace(tenant, siteId), {
      brief: { name, kind: input.kind as SiteKind },
      ...(templateId ? { templateId } : {}),
      userId: ctx.userId,
    });
    return { siteId, version };
  } catch (error) {
    if (tenant) await forgetSiteFiles(tenant, siteId);
    await deps.db.batch([
      deps.db.delete(auditLog).where(eq(auditLog.id, auditId)),
      deps.db.delete(site).where(eq(site.id, siteId)),
    ]);
    if (error instanceof WorkspaceError) throw new SiteInputError(error.message);
    throw error;
  } finally {
    release?.();
  }
}

/** The sites' names from their briefs in the client's database, by site id. */
export async function siteNames(
  deps: Pick<SiteBuilderDeps, "openClientDb">,
  client: AuthorizedClient,
  siteIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (siteIds.length === 0) return names;
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    for (const id of siteIds) {
      const brief = await readBrief(tenant, id);
      if (brief) names.set(id, brief.name);
    }
  } finally {
    release();
  }
  return names;
}
