import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import {
  type ControlDb,
  finishProvisioning,
  type ProvisionDeps,
  provisionLocation,
  type TenantMigration,
  type TenantProvisioner,
} from "@locus/db";
import { agencyGhlConnection, location } from "@locus/db/control";
import type { GhlSession } from "@locus/ghl";
import type { SecretStore } from "@locus/secrets";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  type AgencyGrant,
  exchangeCode,
  type GhlAppConfig,
  type GhlHttp,
  listInstalledLocations,
  mintLocationToken,
  readCompanyName,
  readLocationName,
  refreshGrant,
} from "./ghl-oauth.ts";

export { ConnectError } from "./errors.ts";

export interface ConnectDeps {
  db: ControlDb;
  secrets: SecretStore;
  provisioner: TenantProvisioner;
  ghl: GhlAppConfig;
  http?: GhlHttp;
  migrations?: TenantMigration[];
  now?: () => number;
  /** Waits between checks while another process renews the GHL grant. Tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When the deployment bills: why the agency may not add one more client (given how many
   * are active), or `null` if it may. Absent means no limit.
   */
  newClientRefusal?: (organizationId: string, activeClients: number) => Promise<string | null>;
}

/** Where an agency's GHL grant lives in the secret store. */
export const ghlSecretRef = (organizationId: string) => `/locus/ghl/${organizationId}`;

/** Renew the agency token this long before it expires. */
const REFRESH_EARLY_MS = 5 * 60_000;
/** How long one process may hold the right to renew a grant before another may take over. */
const REFRESH_LEASE_MS = 30_000;
/** How often a process waiting on another's renewal looks for the new grant. */
const REFRESH_POLL_MS = 250;

/**
 * Connects the session's agency to its GHL company with the code from GHL's redirect, then
 * registers every sub-account it installed Locus on. Owners and admins only. Running it again
 * reconnects and picks up new sub-accounts; it never duplicates one.
 */
export async function connectAgency(
  deps: ConnectDeps,
  ctx: SessionContext,
  code: string,
): Promise<SyncResult & { companyId: string }> {
  await requireAgencyManager(deps.db, ctx);
  const grant = await exchangeCode(deps.ghl, code, deps.http, deps.now?.() ?? Date.now());
  return connectAgencyGrant(deps, ctx, grant);
}

/**
 * The GHL agency a grant is for, read before any Locus agency exists for it: its name (for
 * naming the new Locus agency) and whether another Locus agency already holds it. Read-only.
 */
export async function inspectGrant(
  deps: Pick<ConnectDeps, "db" | "http">,
  grant: AgencyGrant,
): Promise<{ companyName: string; claimedBy: string | null }> {
  const [claimed] = await deps.db
    .select({ organizationId: agencyGhlConnection.organizationId })
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.ghlCompanyId, grant.companyId));
  const companyName = await readCompanyName(
    { token: grant.accessToken, companyId: grant.companyId },
    deps.http,
  ).catch(() => "");
  return { companyName, claimedBy: claimed?.organizationId ?? null };
}

/**
 * Connects the session's agency with a grant already exchanged (`exchangeCode`), then registers
 * every sub-account it installed Locus on. Owners and admins only.
 */
export async function connectAgencyGrant(
  deps: ConnectDeps,
  ctx: SessionContext,
  grant: AgencyGrant,
): Promise<SyncResult & { companyId: string }> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const now = deps.now?.() ?? Date.now();

  const [claimed] = await deps.db
    .select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.ghlCompanyId, grant.companyId));
  if (claimed && claimed.organizationId !== organizationId) {
    throw new ConnectError("This GoHighLevel agency is already connected to another Locus agency.");
  }
  const [current] = await deps.db
    .select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, organizationId));
  if (current && current.ghlCompanyId !== grant.companyId) {
    throw new ConnectError(
      "This Locus agency is already connected to a different GoHighLevel agency.",
    );
  }

  const secretRef = ghlSecretRef(organizationId);
  await deps.secrets.set(secretRef, JSON.stringify(grant));
  const values = {
    ghlCompanyId: grant.companyId,
    scopes: grant.scopes,
    secretRef,
    connectedAt: new Date(now),
  };
  await deps.db
    .insert(agencyGhlConnection)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: agencyGhlConnection.organizationId, set: values });

  return { companyId: grant.companyId, ...(await syncLocations(deps, organizationId)) };
}

/** The organisation's GHL connection and the grant kept for it, as stored. */
async function storedGrant(
  deps: Pick<ConnectDeps, "db" | "secrets">,
  organizationId: string,
): Promise<{ secretRef: string; grant: AgencyGrant }> {
  const [connection] = await deps.db
    .select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, organizationId));
  if (!connection) throw new ConnectError("GoHighLevel isn't connected yet.");
  const stored = await deps.secrets.get(connection.secretRef);
  if (!stored) throw new ConnectError("GoHighLevel needs to be connected again.");
  return { secretRef: connection.secretRef, grant: JSON.parse(stored) as AgencyGrant };
}

const grantScopes = (grant: AgencyGrant): readonly string[] =>
  (grant.scopes ?? "").split(/\s+/).filter(Boolean);

/**
 * A current agency token for an organisation's GHL connection, renewed when close to expiry,
 * with the scopes GHL granted it (as its last token response said).
 */
export async function agencyToken(
  deps: Pick<ConnectDeps, "db" | "secrets" | "ghl" | "http" | "now" | "sleep">,
  organizationId: string,
): Promise<{ token: string; companyId: string; scopes: readonly string[] }> {
  let { grant } = await storedGrant(deps, organizationId);
  const now = deps.now?.() ?? Date.now();
  if (grant.expiresAt - REFRESH_EARLY_MS <= now) grant = await renewGrant(deps, organizationId);
  return { token: grant.accessToken, companyId: grant.companyId, scopes: grantScopes(grant) };
}

const isFresh = (grant: AgencyGrant, now: number) => grant.expiresAt - REFRESH_EARLY_MS > now;

/**
 * Renews the organisation's grant, one process at a time. GHL's refresh token is single-use, so
 * when the web app and the agent server both find the grant near expiry, the one that takes the
 * lease renews it and the other waits for the new grant instead of spending the token again.
 */
async function renewGrant(
  deps: Pick<ConnectDeps, "db" | "secrets" | "ghl" | "http" | "now" | "sleep">,
  organizationId: string,
): Promise<AgencyGrant> {
  const clock = () => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mine = eq(agencyGhlConnection.organizationId, organizationId);
  for (let waited = 0; ; waited += REFRESH_POLL_MS) {
    const now = clock();
    const until = new Date(now + REFRESH_LEASE_MS);
    const taken = await deps.db
      .update(agencyGhlConnection)
      .set({ refreshLeaseUntil: until })
      .where(
        and(
          mine,
          or(
            isNull(agencyGhlConnection.refreshLeaseUntil),
            lte(agencyGhlConnection.refreshLeaseUntil, new Date(now)),
          ),
        ),
      )
      .returning({ organizationId: agencyGhlConnection.organizationId });
    if (taken.length > 0) {
      try {
        // Another process may have renewed it between our first read and taking the lease.
        const stored = await storedGrant(deps, organizationId);
        if (isFresh(stored.grant, now)) return stored.grant;
        const grant = await refreshGrant(deps.ghl, stored.grant, deps.http, now);
        await deps.secrets.set(stored.secretRef, JSON.stringify(grant));
        // The agency may have been deleted while GHL answered, its credentials removed first:
        // without its row the new grant would belong to no one, so it goes too.
        const [still] = await deps.db
          .select({ organizationId: agencyGhlConnection.organizationId })
          .from(agencyGhlConnection)
          .where(mine);
        if (!still) {
          await deps.secrets.delete(stored.secretRef);
          throw new ConnectError("This agency isn't connected to GoHighLevel.");
        }
        return grant;
      } finally {
        // Only our own lease: if GHL was slow and the lease passed to another process, it is theirs.
        await deps.db
          .update(agencyGhlConnection)
          .set({ refreshLeaseUntil: null })
          .where(and(mine, eq(agencyGhlConnection.refreshLeaseUntil, until)));
      }
    }
    // Someone else is renewing: use their grant once it lands. A lease left by a process that
    // died expires, and the next pass takes it over.
    const { grant } = await storedGrant(deps, organizationId);
    if (isFresh(grant, now)) return grant;
    if (waited > 2 * REFRESH_LEASE_MS) {
      throw new ConnectError("GoHighLevel's sign-in is being renewed. Try again in a moment.");
    }
    await sleep(REFRESH_POLL_MS);
  }
}

/**
 * A GHL session for one client, for the current request only: it is never stored, logged or
 * returned to the browser. Takes the result of the staff check (`authorizeClient` or
 * `resolveActiveClient`), so it can't be minted for a client the member may not work on.
 */
export async function clientGhlSession(
  deps: ConnectDeps,
  client: AuthorizedClient,
): Promise<GhlSession> {
  assertAuthorizedClient(client);
  const agency = await agencyToken(deps, client.location.organizationId);
  const ghlLocationId = client.location.ghlLocationId;
  return {
    token: await mintLocationToken(agency, ghlLocationId, deps.http),
    tokenKind: "location",
    locationId: ghlLocationId,
    companyId: agency.companyId,
  };
}

/**
 * The scopes the agency's connection was granted (what GHL lets a session do, e.g.
 * `medias.write` before writing to the Media Library), read from the stored grant without
 * asking GHL, and `session` to mint the client's session (`clientGhlSession`) only when a call
 * needs one. Takes the result of the staff check, like `clientGhlSession`.
 */
export async function clientGhl(
  deps: ConnectDeps,
  client: AuthorizedClient,
): Promise<{ session: () => Promise<GhlSession>; scopes: readonly string[] }> {
  assertAuthorizedClient(client);
  const { grant } = await storedGrant(deps, client.location.organizationId);
  return { session: () => clientGhlSession(deps, client), scopes: grantScopes(grant) };
}

/**
 * Proves Locus can act inside the client: mints its session and reads the sub-account's name
 * back from GHL. Read-only.
 */
export async function checkClientGhl(
  deps: ConnectDeps,
  client: AuthorizedClient,
): Promise<{ name: string }> {
  const session = await clientGhlSession(deps, client);
  return { name: await readLocationName(session, deps.http) };
}

export interface SyncResult {
  /** Sub-accounts registered (and given a database) on this run. */
  added: number;
  /** Sub-accounts that were suspended and are installed again. */
  reactivated: number;
  /** Sub-accounts already registered and active. */
  unchanged: number;
  /** Why some installed sub-accounts were not added, when the agency's plan stopped them. */
  refused?: { count: number; reason: string };
}

/**
 * Registers every sub-account GHL says has Locus installed and isn't in the registry yet,
 * finishes any an earlier run left half set up, and reactivates suspended ones that are
 * installed again. Never removes one: an uninstall arrives
 * as a webhook.
 */
export async function syncLocations(
  deps: ConnectDeps,
  organizationId: string,
): Promise<SyncResult> {
  const agency = await agencyToken(deps, organizationId);
  const installed = await listInstalledLocations(deps.ghl, agency, deps.http);
  const known = await deps.db
    .select()
    .from(location)
    .where(eq(location.organizationId, organizationId));
  const byGhlId = new Map(known.map((l) => [l.ghlLocationId, l]));

  const provision: ProvisionDeps = {
    control: deps.db,
    provisioner: deps.provisioner,
    ...(deps.migrations ? { migrations: deps.migrations } : {}),
  };
  const result: SyncResult = { added: 0, reactivated: 0, unchanged: 0 };
  let active = known.filter((l) => l.status === "active").length;
  /** Whether one more client may become active; records the refusal if not. */
  const mayAdd = async () => {
    const reason = (await deps.newClientRefusal?.(organizationId, active)) ?? null;
    if (reason === null) return true;
    result.refused = { count: (result.refused?.count ?? 0) + 1, reason };
    return false;
  };
  for (const item of installed) {
    const existing = byGhlId.get(item.ghlLocationId);
    // Active (or being offboarded): nothing to add.
    if (existing && existing.status !== "provisioning" && existing.status !== "suspended") {
      result.unchanged++;
      continue;
    }
    if (!(await mayAdd())) continue;
    active++;
    if (!existing) {
      await provisionLocation(provision, {
        organizationId,
        ghlLocationId: item.ghlLocationId,
        name: item.name,
      });
      result.added++;
    } else if (existing.status === "provisioning") {
      await finishProvisioning(provision, existing.id);
      result.added++;
    } else if (existing.status === "suspended") {
      await deps.db
        .update(location)
        .set({ status: "active", name: item.name })
        .where(eq(location.id, existing.id));
      result.reactivated++;
    }
  }
  return result;
}

/** `&refused=N&reason=…` for a redirect back to the Connect page, or "" if none were refused. */
export function refusedQuery(result: SyncResult): string {
  if (!result.refused) return "";
  const { count, reason } = result.refused;
  return `&refused=${count}&reason=${encodeURIComponent(reason)}`;
}

/** Suspends one sub-account (GHL uninstalled Locus from it). Its database and data stay. */
export async function suspendLocation(
  db: ControlDb,
  organizationId: string,
  ghlLocationId: string,
): Promise<boolean> {
  const updated = await db
    .update(location)
    .set({ status: "suspended" })
    .where(
      and(eq(location.organizationId, organizationId), eq(location.ghlLocationId, ghlLocationId)),
    )
    .returning({ id: location.id });
  return updated.length > 0;
}
