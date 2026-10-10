import type { ControlDb, TenantProvisioner } from "@locus/db";
import { location, member, memberLocation, session } from "@locus/db/control";
import { and, eq } from "drizzle-orm";

/**
 * Staff client access: which clients (GHL locations) a signed-in member may work on.
 *
 * This is the check GHL cannot do for us — a GHL location token carries no user identity — so
 * it runs before any GHL or Turso token for a client is minted. Everything it needs comes from
 * the session: the agency is the session's active organisation, never a caller-supplied id.
 *
 * - Owners and admins may work on every client of their agency.
 * - Anyone else may work only on the clients listed for them in `member_location`. No rows
 *   means no clients, not all of them.
 */

/** The parts of a Better Auth session the check reads. Take these from the server-side session. */
export interface SessionContext {
  /** The session row's id. */
  id: string;
  userId: string;
  activeOrganizationId?: string | null | undefined;
  activeLocationId?: string | null | undefined;
}

export type LocationRow = typeof location.$inferSelect;

/** A client the session may work on. Only `authorizeClient` creates these. */
export interface AuthorizedClient {
  readonly location: LocationRow;
  readonly memberId: string;
}

/**
 * Refused. Always 403 with the same message, whether the client is someone else's, missing,
 * or simply not on this member's list — the response must not reveal which.
 */
export class ClientAccessDenied extends Error {
  readonly status = 403;
  readonly reason: string;

  constructor(reason: string) {
    super("You don't have access to this client.");
    this.name = "ClientAccessDenied";
    this.reason = reason;
  }
}

const UNRESTRICTED_ROLES = new Set(["owner", "admin"]);
const issued = new WeakSet<AuthorizedClient>();

/** Better Auth stores several roles as one comma-separated string. */
export function rolesOf(role: string): string[] {
  return role
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

async function membership(db: ControlDb, ctx: SessionContext) {
  const organizationId = ctx.activeOrganizationId;
  if (!organizationId) throw new ClientAccessDenied("no active agency on the session");
  const [row] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, ctx.userId), eq(member.organizationId, organizationId)));
  if (!row) throw new ClientAccessDenied("not a member of the session's agency");
  return { member: row, organizationId };
}

/** Decides whether this session may work on `locationId`. Throws `ClientAccessDenied` if not. */
export async function authorizeClient(
  db: ControlDb,
  ctx: SessionContext,
  locationId: string,
): Promise<AuthorizedClient> {
  const { member: m, organizationId } = await membership(db, ctx);

  // Scoped to the session's agency, so another agency's client looks exactly like a missing one.
  const [loc] = await db
    .select()
    .from(location)
    .where(and(eq(location.id, locationId), eq(location.organizationId, organizationId)));
  if (!loc) throw new ClientAccessDenied("no such client in the session's agency");
  if (loc.status !== "active") throw new ClientAccessDenied(`client is ${loc.status}`);

  if (!rolesOf(m.role).some((r) => UNRESTRICTED_ROLES.has(r))) {
    const [grant] = await db
      .select()
      .from(memberLocation)
      .where(and(eq(memberLocation.memberId, m.id), eq(memberLocation.locationId, loc.id)));
    if (!grant) throw new ClientAccessDenied("client is not on this member's list");
  }

  const authorized: AuthorizedClient = Object.freeze({ location: loc, memberId: m.id });
  issued.add(authorized);
  return authorized;
}

/** The active clients this session may work on, for a client picker. */
export async function listAccessibleClients(
  db: ControlDb,
  ctx: SessionContext,
): Promise<LocationRow[]> {
  const { member: m, organizationId } = await membership(db, ctx);
  const inAgency = and(eq(location.organizationId, organizationId), eq(location.status, "active"));
  if (rolesOf(m.role).some((r) => UNRESTRICTED_ROLES.has(r))) {
    return db.select().from(location).where(inAgency);
  }
  const rows = await db
    .select({ location })
    .from(memberLocation)
    .innerJoin(location, eq(memberLocation.locationId, location.id))
    .where(and(eq(memberLocation.memberId, m.id), inAgency));
  return rows.map((r) => r.location);
}

/**
 * Makes `locationId` the session's active client, after the access check. This is the only
 * place a client id comes from the user; everything after reads it from the session.
 */
export async function selectClient(
  db: ControlDb,
  ctx: SessionContext,
  locationId: string,
): Promise<AuthorizedClient> {
  const authorized = await authorizeClient(db, ctx, locationId);
  await db.update(session).set({ activeLocationId: locationId }).where(eq(session.id, ctx.id));
  return authorized;
}

/**
 * The session's active client, checked again on every call — membership, the member's client
 * list and the client's status can all change after it was selected.
 */
export async function resolveActiveClient(
  db: ControlDb,
  ctx: SessionContext,
): Promise<AuthorizedClient> {
  if (!ctx.activeLocationId) throw new ClientAccessDenied("no active client on the session");
  return authorizeClient(db, ctx, ctx.activeLocationId);
}

/**
 * A database token for an authorized client. Takes the result of the access check rather than
 * a location id, so a token cannot be minted without it.
 */
export async function mintClientDbToken(
  provisioner: TenantProvisioner,
  client: AuthorizedClient,
  opts: { readOnly?: boolean; ttl: string },
): Promise<string> {
  if (!issued.has(client)) throw new ClientAccessDenied("client was not authorized");
  return provisioner.mintToken(client.location.tursoDbName, opts);
}
