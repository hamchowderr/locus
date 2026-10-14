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
import { and, eq } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import {
  type AgencyGrant,
  exchangeCode,
  type GhlAppConfig,
  type GhlHttp,
  listInstalledLocations,
  mintLocationToken,
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
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const now = deps.now?.() ?? Date.now();
  const grant = await exchangeCode(deps.ghl, code, deps.http, now);

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

/** A current agency token for an organisation's GHL connection, renewed when close to expiry. */
export async function agencyToken(
  deps: Pick<ConnectDeps, "db" | "secrets" | "ghl" | "http" | "now">,
  organizationId: string,
): Promise<{ token: string; companyId: string }> {
  const [connection] = await deps.db
    .select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, organizationId));
  if (!connection) throw new ConnectError("GoHighLevel isn't connected yet.");
  const stored = await deps.secrets.get(connection.secretRef);
  if (!stored) throw new ConnectError("GoHighLevel needs to be connected again.");

  let grant = JSON.parse(stored) as AgencyGrant;
  const now = deps.now?.() ?? Date.now();
  if (grant.expiresAt - REFRESH_EARLY_MS <= now) {
    grant = await refreshGrant(deps.ghl, grant, deps.http, now);
    await deps.secrets.set(connection.secretRef, JSON.stringify(grant));
  }
  return { token: grant.accessToken, companyId: grant.companyId };
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
