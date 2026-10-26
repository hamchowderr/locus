import { ClientAccessDenied, requireAgencyManager } from "@locus/auth";
import {
  type AgencyGrant,
  ConnectError,
  connectAgencyGrant,
  inspectGrant,
  peekHeldGrant,
  refusedQuery,
  takeHeldGrant,
} from "@locus/connect";
import { agencyGhlConnection, member, organization } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { connectDeps, HELD_GRANT_COOKIE } from "./connect.ts";
import { currentSession, locus, sessionContext } from "./locus.ts";
import { createAgencyFromGrant } from "./onboarding.ts";

type CurrentSession = NonNullable<Awaited<ReturnType<typeof currentSession>>>;

/** What the install page shows for a GoHighLevel marketplace install waiting in this browser. */
export type HeldInstall =
  | { kind: "none" }
  | { kind: "sign-in"; companyName: string }
  | { kind: "taken"; companyName: string }
  | { kind: "ready"; companyName: string; join: { id: string; name: string } | null };

/**
 * The Locus agency a held grant would connect to without making a new one: the agency that
 * already holds this GoHighLevel agency (when the person belongs to it), else their current
 * agency when they manage it and it has no GoHighLevel agency yet, or this same one.
 */
async function joinTarget(
  current: CurrentSession,
  grant: AgencyGrant,
  claimedBy: string | null,
): Promise<{ id: string; name: string } | null> {
  const { db } = locus();
  const named = async (id: string) => {
    const [org] = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, id));
    return org ?? null;
  };
  if (claimedBy) {
    const [mine] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, claimedBy), eq(member.userId, current.user.id)));
    return mine ? named(claimedBy) : null;
  }
  const active = current.session.activeOrganizationId;
  if (!active) return null;
  const manages = await requireAgencyManager(db, sessionContext(current)).then(
    () => true,
    (e: unknown) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  if (!manages) return null;
  const [connected] = await db
    .select({ companyId: agencyGhlConnection.ghlCompanyId })
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, active));
  return !connected || connected.companyId === grant.companyId ? named(active) : null;
}

/** Whether a marketplace install is waiting in this browser. */
export async function hasHeldInstall(): Promise<boolean> {
  const id = (await cookies()).get(HELD_GRANT_COOKIE)?.value;
  return !!id && !!(await peekHeldGrant(connectDeps(), id));
}

export async function heldInstall(): Promise<HeldInstall> {
  const deps = connectDeps();
  const grant = await peekHeldGrant(deps, (await cookies()).get(HELD_GRANT_COOKIE)?.value);
  if (!grant) return { kind: "none" };
  const { companyName, claimedBy } = await inspectGrant(deps, grant);
  const name = companyName || "your agency";
  const current = await currentSession();
  if (!current) return { kind: "sign-in", companyName: name };
  const join = await joinTarget(current, grant, claimedBy);
  if (claimedBy && !join) return { kind: "taken", companyName: name };
  return { kind: "ready", companyName: name, join };
}

/**
 * Connects the held marketplace install once its installer confirms: into the agency the page
 * offered (`join`), or into a new Locus agency named after it, which starts the free trial and
 * the setup. The grant is used once. Returns the outcome for the page it lands on.
 */
export async function finishHeldInstall(choice: "join" | "new"): Promise<string> {
  const current = await currentSession();
  if (!current) throw new ConnectError("Sign in first.");
  const jar = await cookies();
  const deps = connectDeps();
  const grant = await takeHeldGrant(deps, jar.get(HELD_GRANT_COOKIE)?.value);
  jar.delete({ name: HELD_GRANT_COOKIE, path: "/" });
  if (!grant) {
    throw new ConnectError(
      "That install has expired. Install Locus again from the GoHighLevel marketplace, or connect from Locus.",
    );
  }
  const { claimedBy } = await inspectGrant(deps, grant);
  const join = choice === "join" ? await joinTarget(current, grant, claimedBy) : null;
  if (!join) {
    const result = await createAgencyFromGrant(grant);
    return `connected=${result.added}${refusedQuery(result)}`;
  }
  const switching = join.id !== current.session.activeOrganizationId;
  if (switching) {
    await locus().auth.api.setActiveOrganization({
      body: { organizationId: join.id },
      headers: await headers(),
    });
  }
  const result = await connectAgencyGrant(
    deps,
    {
      ...sessionContext(current),
      activeOrganizationId: join.id,
      activeLocationId: switching ? null : current.session.activeLocationId,
    },
    grant,
  );
  return `connected=${result.added}${refusedQuery(result)}`;
}
