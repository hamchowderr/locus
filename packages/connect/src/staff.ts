import { requireAgencyManager, rolesOf, type SessionContext } from "@locus/auth";
import { location, member, memberLocation, user } from "@locus/db/control";
import { type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { eq } from "drizzle-orm";
import { agencyToken, type ConnectDeps } from "./agency.ts";

/** The parts of a GHL user the import reads. */
export interface GhlStaffUser {
  id: string;
  email?: string;
  deleted?: boolean;
  roles?: {
    type?: string;
    role?: string;
    locationIds?: string[];
    restrictSubAccount?: boolean;
  };
}

interface UsersPage {
  users?: GhlStaffUser[];
  count?: number;
}

const PAGE = 100;

/** Every agency-level (staff) user of the GHL company, all pages. Sub-account users are the
 * clients' own logins and are not staff. */
export async function listAgencyStaff(
  deps: ConnectDeps,
  agency: { token: string; companyId: string },
): Promise<GhlStaffUser[]> {
  const op = operationById("users.search-users");
  if (!op) throw new Error("The skill catalog is missing users.search-users");
  const session: GhlSession = {
    token: agency.token,
    tokenKind: "agency",
    companyId: agency.companyId,
  };
  const found: GhlStaffUser[] = [];
  for (let skip = 0; skip < 100_000; skip += PAGE) {
    const res = await ghlRequest<UsersPage>(
      op,
      session,
      { query: { type: "agency", skip: String(skip), limit: String(PAGE) } },
      deps.http,
    );
    const users = res.users ?? [];
    found.push(...users);
    if (users.length < PAGE || (res.count !== undefined && found.length >= res.count)) {
      return found.filter((u) => !u.deleted);
    }
  }
  throw new Error("GoHighLevel kept returning pages of users; stopped at 100,000.");
}

/** Whether GHL already lets this staff user see every sub-account. */
function seesEverything(ghlUser: GhlStaffUser): boolean {
  return ghlUser.roles?.role === "admin" && ghlUser.roles.restrictSubAccount !== true;
}

export interface StaffImportReport {
  /** Locus members whose client list now mirrors GHL. */
  updated: { email: string; clients: number; everyClient: boolean }[];
  /** Locus owners and admins found in GHL — they already reach every client, left as they are. */
  managers: string[];
  /** Locus members with no matching GHL staff user — left as they are. */
  notInGhl: string[];
  /** GHL staff with no Locus account. They need an invitation first. */
  ghlOnly: number;
}

/**
 * Copies which clients each staff member may work on from GHL to Locus, once, on request.
 * GHL is an import source here, never a per-request authority: after this, the Team page is
 * where access is managed.
 *
 * - Matches GHL agency users to this agency's Locus members by email.
 * - A restricted GHL user's sub-accounts become the member's client list (only sub-accounts
 *   Locus has registered for this agency).
 * - A GHL user who sees every sub-account gets every current client.
 * - Locus owners and admins, and every role, are left alone. Members missing from GHL too.
 */
export async function importStaffAccess(
  deps: ConnectDeps,
  ctx: SessionContext,
): Promise<StaffImportReport> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const staff = await listAgencyStaff(deps, await agencyToken(deps, organizationId));
  const byEmail = new Map(
    staff.filter((u) => u.email).map((u) => [u.email?.toLowerCase() ?? "", u] as const),
  );

  const clients = await deps.db
    .select({ id: location.id, ghlLocationId: location.ghlLocationId, status: location.status })
    .from(location)
    .where(eq(location.organizationId, organizationId));
  const clientIdByGhl = new Map(clients.map((c) => [c.ghlLocationId, c.id]));
  const activeClients = clients.filter((c) => c.status === "active").map((c) => c.id);

  const members = await deps.db
    .select({ memberId: member.id, role: member.role, email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId));

  const report: StaffImportReport = { updated: [], managers: [], notInGhl: [], ghlOnly: 0 };
  const matched = new Set<string>();
  for (const m of members) {
    const ghlUser = byEmail.get(m.email.toLowerCase());
    if (!ghlUser) {
      report.notInGhl.push(m.email);
      continue;
    }
    matched.add(m.email.toLowerCase());
    if (rolesOf(m.role).some((r) => r === "owner" || r === "admin")) {
      report.managers.push(m.email);
      continue;
    }
    const everyClient = seesEverything(ghlUser);
    const ids = everyClient
      ? activeClients
      : [
          ...new Set(
            (ghlUser.roles?.locationIds ?? [])
              .map((ghlId) => clientIdByGhl.get(ghlId))
              .filter((id): id is string => id !== undefined),
          ),
        ];
    const clear = deps.db.delete(memberLocation).where(eq(memberLocation.memberId, m.memberId));
    if (ids.length === 0) await clear;
    else {
      await deps.db.batch([
        clear,
        deps.db
          .insert(memberLocation)
          .values(ids.map((locationId) => ({ memberId: m.memberId, locationId }))),
      ]);
    }
    report.updated.push({ email: m.email, clients: ids.length, everyClient });
  }
  report.ghlOnly = [...byEmail.keys()].filter((email) => !matched.has(email)).length;
  return report;
}
