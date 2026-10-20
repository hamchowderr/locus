import type { ControlDb, TenantProvisioner } from "@locus/db";
import {
  location,
  member,
  memberLocation,
  session,
  site,
  siteBuilderOff,
  siteMemberAccess,
  user,
} from "@locus/db/control";
import { and, eq, inArray } from "drizzle-orm";

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

export type LocationRow = typeof location.$inferSelect & {
  /** Whether the agency has the site builder on for this client (the Clients page). */
  siteBuilder: boolean;
};

/** A `location` row with whether its site builder is on, from a select of both tables. */
const located = (r: { location: typeof location.$inferSelect; off: string | null }): LocationRow => ({
  ...r.location,
  siteBuilder: r.off === null,
});

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

const unrestricted = (role: string) => rolesOf(role).some((r) => UNRESTRICTED_ROLES.has(r));

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
  const [row] = await db
    .select({ location, off: siteBuilderOff.locationId })
    .from(location)
    .leftJoin(siteBuilderOff, eq(siteBuilderOff.locationId, location.id))
    .where(and(eq(location.id, locationId), eq(location.organizationId, organizationId)));
  const loc = row && located(row);
  if (!loc) throw new ClientAccessDenied("no such client in the session's agency");
  if (loc.status !== "active") throw new ClientAccessDenied(`client is ${loc.status}`);

  if (!unrestricted(m.role)) {
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
  if (unrestricted(m.role)) {
    const rows = await db
      .select({ location, off: siteBuilderOff.locationId })
      .from(location)
      .leftJoin(siteBuilderOff, eq(siteBuilderOff.locationId, location.id))
      .where(inAgency);
    return rows.map(located);
  }
  const rows = await db
    .select({ location, off: siteBuilderOff.locationId })
    .from(memberLocation)
    .innerJoin(location, eq(memberLocation.locationId, location.id))
    .leftJoin(siteBuilderOff, eq(siteBuilderOff.locationId, location.id))
    .where(and(eq(memberLocation.memberId, m.id), inAgency));
  return rows.map(located);
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
  // A site chosen for the previous client is not this one's.
  await db
    .update(session)
    .set({ activeLocationId: locationId, activeSiteId: null })
    .where(eq(session.id, ctx.id));
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
 * Throws unless `client` came from `authorizeClient` in this process. Anything that mints a
 * token for a client takes an `AuthorizedClient` and calls this first, so the staff check
 * can't be skipped by building the object by hand.
 */
export function assertAuthorizedClient(client: AuthorizedClient): void {
  if (!issued.has(client)) throw new ClientAccessDenied("client was not authorized");
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
  assertAuthorizedClient(client);
  return provisioner.mintToken(client.location.tursoDbName, opts);
}

export interface TeamMember {
  memberId: string;
  name: string;
  email: string;
  role: string;
  /** Whether the role already reaches every client, so the list below doesn't apply. */
  unrestricted: boolean;
  locationIds: string[];
}

/** The session's agency, if the caller is one of its owners or admins. Otherwise a 403. */
export async function requireAgencyManager(db: ControlDb, ctx: SessionContext) {
  const found = await membership(db, ctx);
  if (!unrestricted(found.member.role)) {
    throw new ClientAccessDenied("only owners and admins manage client access");
  }
  return found;
}

/** The agency's members and the clients each may work on. Owners and admins only. */
export async function listTeam(db: ControlDb, ctx: SessionContext): Promise<TeamMember[]> {
  const { organizationId } = await requireAgencyManager(db, ctx);
  const members = await db
    .select({ memberId: member.id, name: user.name, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId));
  const grants = members.length
    ? await db
        .select()
        .from(memberLocation)
        .where(
          inArray(
            memberLocation.memberId,
            members.map((m) => m.memberId),
          ),
        )
    : [];
  return members.map((m) => ({
    ...m,
    unrestricted: unrestricted(m.role),
    locationIds: grants.filter((g) => g.memberId === m.memberId).map((g) => g.locationId),
  }));
}

/**
 * Replaces the list of clients a member may work on. Owners and admins only; the member and
 * every client must belong to the caller's active agency, or nothing changes.
 */
export async function setMemberClients(
  db: ControlDb,
  ctx: SessionContext,
  memberId: string,
  locationIds: string[],
): Promise<void> {
  const { organizationId } = await requireAgencyManager(db, ctx);
  const [target] = await db
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)));
  if (!target) throw new ClientAccessDenied("no such member in the session's agency");

  const wanted = [...new Set(locationIds)];
  if (wanted.length) {
    const found = await db
      .select({ id: location.id })
      .from(location)
      .where(and(eq(location.organizationId, organizationId), inArray(location.id, wanted)));
    if (found.length !== wanted.length) {
      throw new ClientAccessDenied("no such client in the session's agency");
    }
  }

  const clear = db.delete(memberLocation).where(eq(memberLocation.memberId, memberId));
  if (wanted.length === 0) {
    await clear;
    return;
  }
  await db.batch([
    clear,
    db.insert(memberLocation).values(wanted.map((locationId) => ({ memberId, locationId }))),
  ]);
}

export type SiteAccessLevel = "view" | "manage";

/**
 * What the member behind `client` may do with one of its sites: owners and admins always
 * manage; anyone else manages unless an owner or admin made them view-only on that site
 * (`setSiteAccess`). View-only members see the site on the Sites page but can't build, copy,
 * file or publish it. Doesn't check that the site is the client's; callers do.
 */
export async function siteAccessLevel(
  db: ControlDb,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteAccessLevel> {
  assertAuthorizedClient(client);
  const [row] = await db
    .select({ role: member.role, level: siteMemberAccess.level })
    .from(member)
    .leftJoin(
      siteMemberAccess,
      and(eq(siteMemberAccess.memberId, member.id), eq(siteMemberAccess.siteId, siteId)),
    )
    .where(eq(member.id, client.memberId));
  if (!row) throw new ClientAccessDenied("no longer a member of the agency");
  if (unrestricted(row.role)) return "manage";
  return row.level ?? "manage";
}

/** The sites of `client` the member behind it may only view. */
export async function viewOnlySites(db: ControlDb, client: AuthorizedClient): Promise<Set<string>> {
  assertAuthorizedClient(client);
  const rows = await db
    .select({ siteId: siteMemberAccess.siteId, role: member.role })
    .from(siteMemberAccess)
    .innerJoin(site, eq(site.id, siteMemberAccess.siteId))
    .innerJoin(member, eq(member.id, siteMemberAccess.memberId))
    .where(
      and(
        eq(siteMemberAccess.memberId, client.memberId),
        eq(siteMemberAccess.level, "view"),
        eq(site.locationId, client.location.id),
      ),
    );
  return new Set(rows.filter((r) => !unrestricted(r.role)).map((r) => r.siteId));
}

/** A member who may work on a client without reaching every client, and their access to a site. */
export interface SiteMember {
  memberId: string;
  name: string;
  email: string;
  level: SiteAccessLevel;
}

/**
 * The members whose access to one of `client`'s sites can be set: those restricted to a list of
 * clients that includes this one. Owners and admins only.
 */
export async function listSiteMembers(
  db: ControlDb,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteMember[]> {
  assertAuthorizedClient(client);
  await requireAgencyManager(db, ctx);
  const rows = await db
    .select({
      memberId: member.id,
      name: user.name,
      email: user.email,
      role: member.role,
      level: siteMemberAccess.level,
    })
    .from(memberLocation)
    .innerJoin(member, eq(member.id, memberLocation.memberId))
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(
      siteMemberAccess,
      and(eq(siteMemberAccess.memberId, member.id), eq(siteMemberAccess.siteId, siteId)),
    )
    .where(
      and(
        eq(memberLocation.locationId, client.location.id),
        eq(member.organizationId, client.location.organizationId),
      ),
    );
  return rows
    .filter((r) => !unrestricted(r.role))
    .map(({ memberId, name, email, level }) => ({
      memberId,
      name,
      email,
      level: level ?? "manage",
    }));
}

/**
 * Sets which members may only view one of `client`'s sites; every other member who works on the
 * client manages it. Owners and admins only; the site must be the client's and each member one
 * of `listSiteMembers`, or nothing changes.
 */
export async function setSiteAccess(
  db: ControlDb,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
  viewOnlyMemberIds: string[],
): Promise<void> {
  assertAuthorizedClient(client);
  const members = await listSiteMembers(db, ctx, client, siteId);
  const [row] = await db
    .select({ id: site.id })
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ClientAccessDenied("site is not this client's");
  const known = new Set(members.map((m) => m.memberId));
  const wanted = [...new Set(viewOnlyMemberIds)];
  if (wanted.some((id) => !known.has(id))) {
    throw new ClientAccessDenied("member doesn't work on this client");
  }
  // Only the members listed here: a member who was promoted to admin or taken off this client
  // meanwhile keeps their setting for when that changes back.
  const clear = known.size
    ? db
        .delete(siteMemberAccess)
        .where(
          and(eq(siteMemberAccess.siteId, siteId), inArray(siteMemberAccess.memberId, [...known])),
        )
    : null;
  if (!clear) return;
  if (wanted.length === 0) {
    await clear;
    return;
  }
  await db.batch([
    clear,
    db
      .insert(siteMemberAccess)
      .values(wanted.map((memberId) => ({ siteId, memberId, level: "view" as const }))),
  ]);
}

/**
 * Turns the site builder on or off for several of the agency's clients at once. Owners and
 * admins only; every client must be the agency's, or nothing changes. Returns how many changed.
 */
export async function setSiteBuilder(
  db: ControlDb,
  ctx: SessionContext,
  locationIds: string[],
  on: boolean,
): Promise<number> {
  const { organizationId } = await requireAgencyManager(db, ctx);
  const wanted = [...new Set(locationIds)];
  if (wanted.length === 0) return 0;
  const found = await db
    .select({ id: location.id, off: siteBuilderOff.locationId })
    .from(location)
    .leftJoin(siteBuilderOff, eq(siteBuilderOff.locationId, location.id))
    .where(and(eq(location.organizationId, organizationId), inArray(location.id, wanted)));
  if (found.length !== wanted.length) {
    throw new ClientAccessDenied("no such client in the session's agency");
  }
  const changing = found.filter((l) => (l.off === null) !== on).map((l) => l.id);
  if (changing.length === 0) return 0;
  if (on) {
    await db.delete(siteBuilderOff).where(inArray(siteBuilderOff.locationId, changing));
  } else {
    await db.insert(siteBuilderOff).values(changing.map((locationId) => ({ locationId })));
  }
  return changing.length;
}
