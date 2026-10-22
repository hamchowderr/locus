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
  requireAgencyManager,
  type SessionContext,
  siteAccessLevel,
  type UsageMeasurement,
} from "@locus/auth";
import {
  ConnectError,
  commitSiteVersion,
  ensureSiteBackendEnv,
  migrateSiteBackend,
  type PublishDeps,
  type SiteCrm,
  type SiteDeps,
  siteDomainStatus,
} from "@locus/connect";
import { type ControlDb, openTenantDb, type TenantDb, type TenantProvisioner } from "@locus/db";
import {
  auditLog,
  member,
  session,
  site,
  siteBackend,
  siteCheckoutItems,
  siteFolder,
} from "@locus/db/control";
import {
  generationRun,
  siteBlob,
  siteBrief,
  siteDraftFile,
  siteLeadDay,
  siteVersion,
  siteVersionFile,
} from "@locus/db/tenant";
import {
  FakeRuntimeProvider,
  RemoteRuntimeProvider,
  type RuntimeProvider,
  SANDBOX_RPC_PATH,
  type SiteRuntime,
  sandboxFromEnv,
} from "@locus/sandbox";
import {
  bookingCalendarIds,
  checkoutItems,
  editorOrigin,
  type PageSeo,
  pageSeo,
  readBrief,
  type SeoIssue,
  SITE_KINDS,
  SiteWorkspace,
  seoIssues,
  startSite,
  templateById,
  type VersionInfo,
  WorkspaceError,
  withLocusSettings,
  writeBrief,
} from "@locus/studio";
import { and, count, eq, gte, inArray, isNull, notExists, notInArray, sum } from "drizzle-orm";
import { ZodError } from "zod";
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
import { DesignInputError, designFromForm, type NewSiteDesign } from "./site-start.ts";

export * from "./site-history.ts";
export { DesignInputError, designFromForm, type NewSiteDesign } from "./site-start.ts";

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
   * Publishing through the web app, for a host without the GitHub App (`remotePublish`). Used
   * only when `publish` is not set.
   */
  publishVersion?: ((client: AuthorizedClient, siteId: string) => VersionSavedHook) | null;
  /**
   * This deployment's public address. Each published version gets `lib/locus.ts` pointing the
   * site's form route at `<locusUrl>/api/sites/<siteId>/leads` (`withLocusSettings`).
   */
  locusUrl: string;
  /** Billing is on: creating a site needs a plan, within its `sitesPerMonth`. */
  billing?: boolean;
  /**
   * The client's GHL sub-account, for the builder's `crm` tool. Called with the client after
   * the staff check on each tool call; null or absent leaves the tool saying it can't reach it.
   */
  crm?: ((client: AuthorizedClient) => SiteCrm) | null;
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
/** The pages allowed to drive a preview's visual edits: the Locus web app's own origin. */
export function editorOrigins(locusUrl: string): string[] {
  const origin = editorOrigin(locusUrl);
  return origin ? [origin] : [];
}

export const siteRuntimeKey = (client: AuthorizedClient, siteId: string) =>
  `${client.location.id}/${siteId}`;

/**
 * The control `site` row for `siteId`, only if it is this client's. Refuses (403, saying no
 * more) a missing site and another client's site alike.
 */
/**
 * The control `site` row for `siteId`, only if it is this client's, whether or not the member may
 * build it: for showing a site, never for changing it (use `clientSite`).
 */
export async function siteOfClient(db: ControlDb, client: AuthorizedClient, siteId: string) {
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

export const SITE_BUILDER_OFF =
  "The site builder is turned off for this client. An owner or admin can turn it on on the Clients page.";
export const SITE_VIEW_ONLY =
  "You can view this site but not change it. An owner or admin can change that on the Sites page.";
export const SITE_LINKED =
  "This site was linked from an existing Vercel project, so it can't be built in Locus.";

/**
 * Why the member behind `client` may not build `siteId` (a site of the client), or null: the
 * site builder is off for the client, or the member is view-only on the site.
 */
export async function buildRefusal(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
): Promise<string | null> {
  if (!client.location.siteBuilder) return SITE_BUILDER_OFF;
  if ((await siteAccessLevel(db, client, siteId)) === "view") return SITE_VIEW_ONLY;
  return null;
}

/**
 * The control `site` row for `siteId`, only if it is this client's and the member behind
 * `client` may build it (`buildRefusal`). Refuses (403, saying no more) a missing site, another
 * client's site and one the member may not build alike; check `buildRefusal` first to say why.
 */
export async function clientSite(db: ControlDb, client: AuthorizedClient, siteId: string) {
  const row = await siteOfClient(db, client, siteId);
  if (row.origin === "linked") throw new ClientAccessDenied(SITE_LINKED);
  const refusal = await buildRefusal(db, client, row.id);
  if (refusal) throw new ClientAccessDenied(refusal);
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
  /^Connect GitHub on the Integrations page first\.$/,
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
  // An app-style site's own database: the reason is the database's, for SQL the agent wrote.
  /^The site's database change didn't apply: [^\n]{1,1500}$/,
  /^This site's database isn't set up on this deployment yet\.$/,
  /^The site's database wasn't saved\. Try again\.$/,
  /^Locus couldn't make the site's database\. Try again\.$/,
  /^This site's database was removed, so Locus won't make a new one on its own\. Take the db\/migrations files out to publish it as a plain website\.$/,
  /^Vercel didn't (show|take|remove) the site's (database )?settings\. Try again\.$/,
  /^Vercel refused\. Reconnect Vercel on the Integrations page and allow access to all projects\.$/,
];

const GENERIC_PUBLISH_ERROR =
  "The version is saved, but GitHub refused it. Check that the Locus app can still reach the " +
  "site's repository, then save again.";
const SITES_PAGE_PUBLISH_ERROR =
  "GitHub refused the publish. Check that the Locus app can still reach the site's " +
  "repository, then publish again.";

/**
 * The address a published site goes by, for its sitemap, links and structured data: its own
 * domain once that is live (verified and pointing at Vercel), else its Vercel address. Null
 * before either exists, when the site falls back to the host's production address at build.
 */
export async function siteAddress(
  deps: SiteDeps,
  client: AuthorizedClient,
  row: { id: string; customDomain: string | null; deployUrl: string | null },
): Promise<string | null> {
  if (row.customDomain) {
    // A domain still being set up (or a check that fails) doesn't hold up the publish.
    const status = await siteDomainStatus(deps, client, row.id).catch(() => null);
    if (status?.state === "live") return `https://${row.customDomain}`;
  }
  return row.deployUrl;
}

/** What runs after each saved version (`BuilderSession.onVersionSaved`). */
export type VersionSavedHook = NonNullable<BuilderSession["onVersionSaved"]>;

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
): VersionSavedHook {
  return async (version: VersionInfo, files) => {
    const row = await clientSite(db, client, siteId);
    if (!row.repoFullName) return undefined;
    // The calendars this version books on: the only ones its visitors may book once it's live.
    // Recorded before the push, so the new deployment never refuses its own calendars.
    await db
      .update(site)
      .set({ bookingCalendars: bookingCalendarIds(files) })
      .where(eq(site.id, row.id));
    // Likewise the products and prices it sells: a checkout of anything else is refused.
    const items = checkoutItems(files);
    await db
      .insert(siteCheckoutItems)
      .values({ siteId: row.id, items })
      .onConflictDoUpdate({ target: siteCheckoutItems.siteId, set: { items } });
    try {
      const deps = publish();
      // An app-style site's database gets the version's changes first, and its project the
      // database's settings, so the build this push starts runs against a ready database.
      await migrateSiteBackend(deps, client, { siteId, files });
      await ensureSiteBackendEnv(deps, client, { siteId });
      const siteUrl = await siteAddress(deps, client, row);
      const { commitSha, url } = await commitSiteVersion(deps, client, {
        siteId,
        message: `Version ${version.number}: ${version.message}`,
        // The version's files, with this site's form endpoint and address in `lib/locus.ts`.
        files: withLocusSettings(
          files.map(({ path, content }) => ({ path, content })),
          { siteId, locusUrl, siteUrl },
        ),
      });
      return { commitSha, url };
    } catch (error) {
      if (error instanceof ConnectError) throw new PublishError(publishMessage(error));
      throw error;
    }
  };
}

/**
 * Sends a site's latest saved version to its repository from the Sites page, as a save in the
 * chat does (`publishHook`), for a deployment without the chat or a site whose repository came
 * after its last save. Owners and admins only. The client is the session's; the site must be
 * one of its and have a repository. Vercel deploys the push.
 */
export async function publishLatestVersion(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb" | "publish" | "locusUrl">,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<{ version: number; commitSha: string }> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  if (!client.location.siteBuilder) throw new SiteInputError(SITE_BUILDER_OFF);
  const row = await clientSite(deps.db, client, siteId);
  if (!row.repoFullName) {
    throw new SiteInputError("Give the site a GitHub repository first.");
  }
  if (!deps.publish) throw new SiteInputError("Publishing to GitHub isn't set up here yet.");
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    const workspace = new SiteWorkspace(tenant, siteId);
    const hook = publishHook(deps.db, deps.publish, client, siteId, deps.locusUrl);
    let version = await workspace.latestVersion();
    if (!version) throw new SiteInputError("This site has no saved version to publish yet.");
    // A save in the chat can land while this commits; the newest version must end up on top,
    // so a newer one seen afterwards is published too (each push builds on the branch head).
    for (let attempt = 0; ; attempt++) {
      const files = await workspace.versionFiles(version.id);
      let published: Awaited<ReturnType<VersionSavedHook>>;
      try {
        published = await hook(version, files);
      } catch (error) {
        if (error instanceof PublishError) {
          throw new SiteInputError(
            error.message === GENERIC_PUBLISH_ERROR ? SITES_PAGE_PUBLISH_ERROR : error.message,
          );
        }
        throw error;
      }
      if (!published?.commitSha) {
        throw new SiteInputError("Give the site a GitHub repository first.");
      }
      // The commit is on GitHub either way; only the version's record of it can fail here.
      await workspace.setCommitSha(version.id, published.commitSha).catch((error: unknown) => {
        console.error(`Recording the commit for site ${siteId} failed`, error);
      });
      const latest = await workspace.latestVersion();
      if (!latest || latest.id === version.id || attempt >= 2) {
        return { version: version.number, commitSha: published.commitSha };
      }
      version = latest;
    }
  } finally {
    release();
  }
}

// One pooled connection per client database, shared by every builder in the process. It is
// replaced (with a freshly minted token) before the token's hour is up, and a replaced or
// closed connection is closed only once no call is still using it.

interface PooledDb {
  db: Promise<TenantDb>;
  until: number;
  users: number;
  retired: boolean;
  /** Closes the connection once it has gone unused for `POOL_IDLE_MS`. */
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * A pooled connection is replaced after this long. Its token lives an hour (`openClientDb`), so a
 * call that leased it just before then still has a quarter of an hour.
 */
const POOL_LIFETIME_MS = 45 * 60_000;
/** A connection nobody has used for this long is closed, so idle clients hold nothing open. */
export const POOL_IDLE_MS = 5 * 60_000;
const pool = new Map<string, PooledDb>();

function closeIfIdle(entry: PooledDb) {
  if (!entry.retired || entry.users > 0) return;
  entry.db.then((db) => db.$client.close()).catch(() => {});
}

function retire(locationId: string) {
  const entry = pool.get(locationId);
  if (!entry) return;
  clearTimeout(entry.idle);
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
  clearTimeout(leased.idle);
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
      if (leased.users === 0 && !leased.retired) {
        clearTimeout(leased.idle);
        leased.idle = setTimeout(() => {
          if (pool.get(id) === leased && leased.users === 0) retire(id);
        }, POOL_IDLE_MS);
        // Never keeps the process alive.
        leased.idle.unref?.();
      }
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

/** How a Locus backend off Vercel reaches the web app (`remoteSiteRuntimes`, `remotePublish`). */
export interface WebAppOptions {
  /** The web app's base URL. */
  url: string;
  /** `BETTER_AUTH_SECRET`, shared with the web app. */
  authSecret: string;
  /**
   * The Vercel project's automation bypass, for a web app behind Vercel's deployment
   * protection (previews, staging). Sent as `x-vercel-protection-bypass`; it only gets past
   * Vercel's login wall, and the route's own token check still runs.
   */
  vercelBypass?: string;
  fetch?: typeof fetch;
}

/** `fetch` for calls to the web app, with the Vercel bypass header when there is one. */
function webFetch(options: WebAppOptions): typeof fetch {
  const send = options.fetch ?? fetch;
  const bypass = options.vercelBypass;
  if (!bypass) return send;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-vercel-protection-bypass", bypass);
    return send(input, { ...init, headers });
  };
}

/** A short-lived agent-to-web token for the member and client behind `client`. */
function tokenFor(key: string, client: AuthorizedClient): string {
  return mintAgentToWebToken(key, {
    memberId: client.memberId,
    locationId: client.location.id,
    organizationId: client.location.organizationId,
  });
}

/**
 * Sandboxes driven through the web app's `/api/internal/sandbox` (see `RemoteRuntimeProvider`),
 * for `SiteBuilderDeps.openRuntime` on a host off Vercel. Each call carries a short-lived token
 * naming the member and client, so the web app runs the staff check itself; no credential for
 * Vercel leaves it.
 */
export function remoteSiteRuntimes(
  options: WebAppOptions,
): (client: AuthorizedClient, siteId: string) => Promise<SiteRuntime> {
  const key = agentToWebKey(options.authSecret);
  const url = `${options.url.replace(/\/+$/, "")}${SANDBOX_RPC_PATH}`;
  const fetchWeb = webFetch(options);
  return (client, siteId) => {
    assertAuthorizedClient(client);
    return new RemoteRuntimeProvider({
      url,
      mintToken: () => tokenFor(key, client),
      fetch: fetchWeb,
    }).open(siteId);
  };
}

/**
 * `hook`, run only once the site has a repository, as `publishHook` does: a site without one
 * is left alone with no call to the web app.
 */
function withRepoOnly(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
  hook: VersionSavedHook,
): VersionSavedHook {
  return async (version, files) => {
    const row = await clientSite(db, client, siteId);
    if (!row.repoFullName) return undefined;
    return hook(version, files);
  };
}

/** The longest a publish call may take; the web app's route allows 300 s (`maxDuration`). */
const PUBLISH_CALL_MS = 280_000;

/** The web app's route that publishes a saved version for a backend off Vercel. */
export const PUBLISH_RPC_PATH = "/api/internal/publish";

/** The answer the publish route gives, success or refusal. */
interface PublishRpcBody {
  commitSha?: unknown;
  url?: unknown;
  error?: unknown;
}

/**
 * Publishing saved versions through the web app's `/api/internal/publish`, for
 * `SiteBuilderDeps.publishVersion` on a host without the GitHub App (the agent server). Only the
 * site and version ids travel, with a short-lived token naming the member and client: the web
 * app runs the staff check, reads the version's files from the client's database itself, and
 * publishes them as `publishHook` does. A refusal written for the person (422) comes back as a
 * `PublishError`; anything else is a plain error, which the tools report generically.
 */
export function remotePublish(
  options: WebAppOptions,
): (client: AuthorizedClient, siteId: string) => VersionSavedHook {
  const key = agentToWebKey(options.authSecret);
  const url = `${options.url.replace(/\/+$/, "")}${PUBLISH_RPC_PATH}`;
  const fetchWeb = webFetch(options);
  return (client, siteId) => {
    assertAuthorizedClient(client);
    return async (version) => {
      const response = await fetchWeb(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenFor(key, client)}`,
        },
        body: JSON.stringify({ siteId, versionId: version.id }),
        // Never follow a redirect: it would carry the token to another address.
        redirect: "error",
        signal: AbortSignal.timeout(PUBLISH_CALL_MS),
      });
      const body = (await response.json().catch(() => null)) as PublishRpcBody | null;
      if (response.status === 422 && typeof body?.error === "string") {
        throw new PublishError(body.error);
      }
      if (!response.ok) {
        // Logged for the operator (a wrong secret or bypass shows up here); the person gets
        // the tools' generic message.
        console.error(`Publishing through the web app failed: it answered ${response.status}`);
        throw new Error(`the web app answered ${response.status} to a publish call`);
      }
      return {
        ...(typeof body?.commitSha === "string" ? { commitSha: body.commitSha } : {}),
        ...(typeof body?.url === "string" ? { url: body.url } : {}),
      };
    };
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
      // Not a refusal: nobody has chosen a site for this chat yet. Say what to do.
      throw new BuilderError(
        "No site is available for this chat. Choose one on the Sites page, then try again.",
      );
    }
    const given = input.requester
      ? await input.requester(requestContext)
      : (contextValue(requestContext, CLIENT_KEY) as AuthorizedClient | undefined);
    // A host that names the run's member must always name one: never fall back to `bound`,
    // which may be another member of the client.
    if (input.requester && !given) throw new ClientAccessDenied("run has no member");
    const requester = given ?? bound;
    assertAuthorizedClient(requester);
    if (requester.location.id !== bound.location.id) {
      throw new ClientAccessDenied("request is for another client");
    }
    const { client, userId } = await reauthorize(deps.db, requester);
    const row = await siteOfClient(deps.db, client, siteId);
    if (row.origin === "linked") throw new BuilderError(SITE_LINKED);
    const refusal = await buildRefusal(deps.db, client, row.id);
    if (refusal) throw new BuilderError(refusal);
    const lease = await leaseClientDb(deps.openClientDb, client);
    const onVersionSaved = deps.publish
      ? publishHook(deps.db, deps.publish, client, siteId, deps.locusUrl)
      : deps.publishVersion
        ? withRepoOnly(deps.db, client, siteId, deps.publishVersion(client, siteId))
        : undefined;
    return {
      workspace: new SiteWorkspace(lease.db, siteId),
      release: lease.release,
      runtime: () =>
        deps.openRuntime
          ? deps.openRuntime(client, siteId)
          : deps.runtimes().open(siteRuntimeKey(client, siteId)),
      images: deps.images ?? null,
      crm: deps.crm ? deps.crm(client) : null,
      meter: usageMeter(deps.db, client, { siteId, userId }),
      userId,
      editorOrigins: editorOrigins(deps.locusUrl),
      ...(onVersionSaved ? { onVersionSaved } : {}),
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
 * it is `client`'s (another client's site throws `ClientAccessDenied`, one the member may not
 * build `SiteInputError`). The agent server, which gets no cookies, reads it back with
 * `activeSiteIdForSession`.
 */
export async function chooseActiveSite(
  db: ControlDb,
  ctx: Pick<SessionContext, "id">,
  client: AuthorizedClient,
  siteId: string,
): Promise<string> {
  const row = await siteOfClient(db, client, siteId);
  if (row.origin === "linked") throw new SiteInputError(SITE_LINKED);
  const refusal = await buildRefusal(db, client, row.id);
  if (refusal) throw new SiteInputError(refusal);
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

export interface NewSite extends NewSiteDesign {
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
  if (!client.location.siteBuilder) throw new SiteInputError(SITE_BUILDER_OFF);
  let design: ReturnType<typeof designFromForm>;
  try {
    design = designFromForm(input);
  } catch (error) {
    if (error instanceof DesignInputError) throw new SiteInputError(error.message);
    throw error;
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
      brief: { ...design.brief, name, kind: input.kind as SiteKind },
      files: design.files,
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

/**
 * Copies a site's latest saved version into a new draft site of `to`, which may be the same
 * client or another one of the agency's. Both clients passed the staff check for this member,
 * so a member restricted to some clients can only copy between those. The copy gets its own
 * row, brief (renamed) and version 1, and nothing else: no history, repository, Vercel project,
 * domain or form leads. It counts as a new site against the agency's plan. The site's folder
 * comes along only within the same client.
 */
export async function copyClientSite(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb" | "billing">,
  ctx: SessionContext,
  from: AuthorizedClient,
  siteId: string,
  to: AuthorizedClient,
  input: { name: string },
): Promise<{ siteId: string; version: VersionInfo }> {
  assertAuthorizedClient(from);
  assertAuthorizedClient(to);
  if (from.location.organizationId !== to.location.organizationId) {
    throw new ClientAccessDenied("clients are in different agencies");
  }
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new SiteInputError("Give the copy a name of up to 120 characters.");
  }
  const source = await siteOfClient(deps.db, from, siteId);
  if (source.origin === "linked") throw new SiteInputError(SITE_LINKED);
  const refusal = await buildRefusal(deps.db, from, source.id);
  if (refusal) throw new SiteInputError(refusal);
  if (!to.location.siteBuilder) throw new SiteInputError(SITE_BUILDER_OFF);
  if (deps.billing) {
    const refusal = await newSiteRefusal(deps.db, to.location.organizationId);
    if (refusal) throw new SiteInputError(refusal);
  }

  // Read everything first and let the connection go, so the copy never holds two at once.
  const read = await leaseClientDb(deps.openClientDb, from);
  let files: Awaited<ReturnType<SiteWorkspace["versionFiles"]>>;
  let brief: Awaited<ReturnType<typeof readBrief>>;
  let fromVersion: VersionInfo | null;
  try {
    const workspace = new SiteWorkspace(read.db, source.id);
    brief = await readBrief(read.db, source.id);
    fromVersion = await workspace.latestVersion();
    files = fromVersion ? await workspace.versionFiles(fromVersion.id) : [];
  } finally {
    read.release();
  }
  if (!brief || !fromVersion) {
    throw new SiteInputError("Only a site built in Locus, with a saved version, can be copied.");
  }

  const newId = randomUUID();
  const auditId = randomUUID();
  await deps.db.batch([
    deps.db.insert(site).values({
      id: newId,
      locationId: to.location.id,
    }),
    deps.db.insert(auditLog).values({
      id: auditId,
      organizationId: to.location.organizationId,
      actorUserId: ctx.userId,
      locationId: to.location.id,
      action: "site.create",
      detail: {
        siteId: newId,
        copiedFrom: {
          locationId: from.location.id,
          siteId: source.id,
          version: fromVersion.number,
        },
      },
    }),
  ]);
  // A copy for the same client stays in the original's folder.
  if (to.location.id === from.location.id) {
    const [folder] = await deps.db
      .select({ name: siteFolder.name })
      .from(siteFolder)
      .where(eq(siteFolder.siteId, source.id));
    if (folder) await deps.db.insert(siteFolder).values({ siteId: newId, name: folder.name });
  }
  let tenant: TenantDb | undefined;
  let release: (() => void) | undefined;
  try {
    ({ db: tenant, release } = await leaseClientDb(deps.openClientDb, to));
    const workspace = new SiteWorkspace(tenant, newId);
    await workspace.writeFiles(files);
    const version = await workspace.saveVersion({
      message: `Copied from ${brief.name}, version ${fromVersion.number}`,
      source: "copy",
      userId: ctx.userId,
    });
    if (!version) throw new SiteInputError("That site's latest version has no files to copy.");
    await writeBrief(tenant, newId, { ...brief, name });
    return { siteId: newId, version };
  } catch (error) {
    if (tenant) await forgetSiteFiles(tenant, newId);
    await deps.db.batch([
      deps.db.delete(auditLog).where(eq(auditLog.id, auditId)),
      deps.db.delete(site).where(eq(site.id, newId)),
    ]);
    if (error instanceof WorkspaceError) throw new SiteInputError(error.message);
    throw error;
  } finally {
    release?.();
  }
}

/**
 * Deletes a site of the session's client (the client from `client`, never the form): its
 * files, versions, brief and runs in the client's own database, then its control row, with an
 * audit entry; any session that had chosen it forgets it. Owners and admins only.
 *
 * A site saved to a repository can be deleted too: Locus never deletes anything on the
 * agency's GitHub, so the repository stays. A site with a Vercel project or a custom domain is
 * refused: its copy may be live (on `*.vercel.app` or a domain added on Vercel), and its forms
 * would stop reaching the CRM with no way to point them at a new site. Unlinking the project
 * first (`unlinkHostProject`) is the owner's deliberate step.
 * The site's `site.create` entry stays, so deleting doesn't give back plan allowance. Its
 * sandbox is deleted last, best effort (`RuntimeProvider.destroy`): no one can reach it once the
 * row is gone, and one left behind only stops when its timeout ends.
 */
export async function deleteClientSite(
  deps: Pick<SiteBuilderDeps, "db" | "openClientDb"> & Partial<Pick<SiteBuilderDeps, "runtimes">>,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<void> {
  assertAuthorizedClient(client);
  await requireAgencyManager(deps.db, ctx);
  // Not `clientSite`: owners and admins may tidy away drafts with the site builder off.
  const row = await siteOfClient(deps.db, client, siteId);
  if (row.hostProjectId || row.customDomain) {
    throw new SiteInputError(
      "This site may be live on Vercel. Remove its domain and unlink its Vercel project first, then delete the site.",
    );
  }
  const [backend] = await deps.db
    .select({ siteId: siteBackend.siteId })
    .from(siteBackend)
    .where(eq(siteBackend.siteId, row.id));
  if (backend) {
    // Its database holds the site's own records (sign-ups, bookings), which a draft delete
    // must not take with it unasked.
    throw new SiteInputError("This site has its own database, so it can't be deleted here.");
  }
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    const versions = tenant
      .select({ id: siteVersion.id })
      .from(siteVersion)
      .where(eq(siteVersion.siteId, siteId));
    // One transaction, so a write to another site can't land between the deletes and the
    // sweep of contents no file uses any more. Another writer holding the lock is waited out.
    await whenNotBusy(() =>
      tenant.batch([
        tenant.delete(siteVersionFile).where(inArray(siteVersionFile.versionId, versions)),
        tenant.delete(siteVersion).where(eq(siteVersion.siteId, siteId)),
        tenant.delete(siteDraftFile).where(eq(siteDraftFile.siteId, siteId)),
        tenant.delete(siteBrief).where(eq(siteBrief.siteId, siteId)),
        tenant.delete(generationRun).where(eq(generationRun.siteId, siteId)),
        tenant.delete(siteLeadDay).where(eq(siteLeadDay.siteId, siteId)),
        tenant
          .delete(siteBlob)
          .where(
            and(
              notInArray(
                siteBlob.hash,
                tenant.select({ hash: siteDraftFile.blobHash }).from(siteDraftFile),
              ),
              notInArray(
                siteBlob.hash,
                tenant.select({ hash: siteVersionFile.blobHash }).from(siteVersionFile),
              ),
            ),
          ),
      ]),
    );
  } finally {
    release();
  }
  // The row goes only if it is still this client's and not on Vercel: a project or domain
  // added while the files were being deleted keeps it.
  const [, removed] = await deps.db.batch([
    deps.db.update(session).set({ activeSiteId: null }).where(eq(session.activeSiteId, siteId)),
    deps.db
      .delete(site)
      .where(
        and(
          eq(site.id, siteId),
          eq(site.locationId, client.location.id),
          isNull(site.hostProjectId),
          isNull(site.customDomain),
          // Nor if it got its own database meanwhile: that database must not be orphaned.
          notExists(
            deps.db
              .select({ siteId: siteBackend.siteId })
              .from(siteBackend)
              .where(eq(siteBackend.siteId, site.id)),
          ),
        ),
      )
      .returning({ id: site.id }),
  ]);
  if (removed.length === 0) {
    throw new SiteInputError("The site got a domain while it was being deleted. Reload the page.");
  }
  await deps.db.insert(auditLog).values({
    id: randomUUID(),
    organizationId: client.location.organizationId,
    actorUserId: ctx.userId,
    locationId: client.location.id,
    action: "site.delete",
    detail: { siteId },
  });
  try {
    await deps.runtimes?.().destroy?.(siteRuntimeKey(client, siteId));
  } catch (error) {
    console.error("The deleted site's sandbox wasn't removed", { siteId, error });
  }
}

const isBusy = (error: unknown) =>
  /SQLITE_BUSY|database is locked/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ""}`);

/** Runs `work`, waiting out another writer holding the database lock with a short backoff. */
async function whenNotBusy<T>(work: () => Promise<T>, retries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isBusy(error) || attempt >= retries) throw error;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
    }
  }
}

/** The days `siteLeadTotals` adds up, today included. */
export const LEAD_TOTAL_DAYS = 30;

/**
 * Leads each site's forms sent to the CRM, and leads that failed, over the last
 * `LEAD_TOTAL_DAYS` days (UTC). Sites with none are left out.
 */
export async function siteLeadTotals(
  deps: Pick<SiteBuilderDeps, "openClientDb">,
  client: AuthorizedClient,
  siteIds: string[],
  now = Date.now(),
): Promise<Map<string, { delivered: number; failed: number }>> {
  const totals = new Map<string, { delivered: number; failed: number }>();
  if (siteIds.length === 0) return totals;
  const since = new Date(now - (LEAD_TOTAL_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    const rows = await tenant
      .select({
        siteId: siteLeadDay.siteId,
        delivered: sum(siteLeadDay.delivered).mapWith(Number),
        failed: sum(siteLeadDay.failed).mapWith(Number),
      })
      .from(siteLeadDay)
      .where(and(inArray(siteLeadDay.siteId, siteIds), gte(siteLeadDay.day, since)))
      .groupBy(siteLeadDay.siteId);
    for (const { siteId, delivered, failed } of rows) totals.set(siteId, { delivered, failed });
  } finally {
    release();
  }
  return totals;
}

/** What search engines will see of a site's latest saved version, page by page. */
export interface SiteSeo {
  version: number;
  pages: PageSeo[];
  issues: SeoIssue[];
}

/**
 * The search check of each site's latest saved version, for the Sites page: its pages' titles,
 * descriptions and structured data, and what to fix. A site without a saved version is left
 * out. The client is the caller's (after the staff check); the ids are its sites.
 */
export async function siteSeo(
  deps: Pick<SiteBuilderDeps, "openClientDb">,
  client: AuthorizedClient,
  siteIds: string[],
): Promise<Map<string, SiteSeo>> {
  const checks = new Map<string, SiteSeo>();
  if (siteIds.length === 0) return checks;
  const { db: tenant, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    for (const id of siteIds) {
      const workspace = new SiteWorkspace(tenant, id);
      const version = await workspace.latestVersion();
      if (!version) continue;
      const files = await workspace.versionFiles(version.id);
      checks.set(id, {
        version: version.number,
        pages: pageSeo(files),
        issues: seoIssues(files),
      });
    }
  } finally {
    release();
  }
  return checks;
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
      // One brief that no longer reads (an older format) mustn't hide every other site.
      const brief = await readBrief(tenant, id).catch((error) => {
        if (!(error instanceof ZodError)) throw error;
        console.error("A site's brief couldn't be read", { siteId: id, error });
        return null;
      });
      if (brief) names.set(id, brief.name);
    }
  } finally {
    release();
  }
  return names;
}

export { saveVisualEdits, type VisualEditsSaved } from "./visual-edits.ts";
