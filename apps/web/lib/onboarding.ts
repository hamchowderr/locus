import { ClientAccessDenied, rememberAgency, requireAgencyManager, startTrial } from "@locus/auth";
import {
  beginOnboarding,
  ConnectError,
  connectAgencyGrant,
  exchangeCode,
  inspectGrant,
  type OnboardingStep,
  onboardingOpen,
  onboardingStep,
  type SyncResult,
} from "@locus/connect";
import { agencyTrial, member, organization } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { connectDeps } from "./connect.ts";
import { currentSession, locus, sessionContext } from "./locus.ts";

type CurrentSession = NonNullable<Awaited<ReturnType<typeof currentSession>>>;

/**
 * The setup step to send this person to, or null. Only owners and admins do the setup; other
 * members of an agency still setting up go on to the chat as usual.
 */
export async function setupStepFor(current: CurrentSession): Promise<OnboardingStep | null> {
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) return "ghl";
  const step = await onboardingStep(locus().db, organizationId);
  if (!step) return null;
  const manager = await requireAgencyManager(locus().db, sessionContext(current)).then(
    () => true,
    (e: unknown) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  return manager ? step : null;
}

/**
 * Where an integration's callback sends the person back to: the setup while their agency is
 * still going through it, else the Integrations page. `query` carries the outcome either way.
 */
export async function integrationsReturn(query: string): Promise<string> {
  const current = await currentSession();
  const organizationId = current?.session.activeOrganizationId;
  // No agency yet: its setup failed at the first step, which is where to show why.
  const open = organizationId ? await onboardingOpen(locus().db, organizationId) : true;
  return `${open ? "/onboarding" : "/connect"}?${query}`;
}

const slugOf = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agency"
  }-${crypto.randomUUID().slice(0, 6)}`;

/**
 * The first step of a new agency's setup: someone signed in with no agency yet approved Locus
 * in GoHighLevel. The Locus agency is created here, named after the GoHighLevel agency, starts
 * its free trial and its setup, and is connected with the same grant, so its installed
 * sub-accounts arrive at once.
 *
 * A GoHighLevel agency another Locus agency already holds is refused before anything is made;
 * its owner can invite this person instead.
 */
export async function createAgencyFromGhl(code: string): Promise<SyncResult> {
  const current = await currentSession();
  if (!current) throw new ConnectError("Sign in first.");
  const deps = connectDeps();
  const grant = await exchangeCode(deps.ghl, code, deps.http);
  const { companyName, claimedBy } = await inspectGrant(deps, grant);
  const requestHeaders = await headers();
  if (claimedBy) {
    const [mine] = await locus()
      .db.select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, claimedBy), eq(member.userId, current.user.id)));
    if (mine) {
      // Already theirs: go to it rather than make a second one.
      await locus().auth.api.setActiveOrganization({
        body: { organizationId: claimedBy },
        headers: requestHeaders,
      });
      throw new ConnectError(
        "This GoHighLevel agency is already in Locus, in an agency you belong to, so you're in it now.",
      );
    }
    throw new ConnectError(
      "This GoHighLevel agency is already connected to another Locus agency. Ask its owner to invite you.",
    );
  }

  const name = companyName || "My agency";
  const agency = await locus().auth.api.createOrganization({
    body: { name, slug: slugOf(name) },
    headers: requestHeaders,
  });
  if (!agency) throw new ConnectError("The agency could not be created. Try again.");
  await locus().auth.api.setActiveOrganization({
    body: { organizationId: agency.id },
    headers: requestHeaders,
  });
  const { db } = locus();
  await rememberAgency(db, current.user.id, agency.id);
  await beginOnboarding(db, agency.id);
  // Before connecting: the trial is what lets its sub-accounts in.
  await startTrial(db, agency.id, current.user.id).catch((error: unknown) => {
    console.error("Starting the free trial failed", error);
  });
  try {
    return await connectAgencyGrant(
      deps,
      { ...sessionContext(current), activeOrganizationId: agency.id, activeLocationId: null },
      grant,
    );
  } catch (error) {
    // Don't leave an agency that can never connect (say someone else claimed the same
    // GoHighLevel agency a moment earlier): remove it, so connecting again starts clean.
    await db.delete(agencyTrial).where(eq(agencyTrial.organizationId, agency.id));
    await db.delete(organization).where(eq(organization.id, agency.id));
    await locus()
      .auth.api.setActiveOrganization({ body: { organizationId: null }, headers: requestHeaders })
      .catch(() => {});
    if (error instanceof ConnectError) throw error;
    console.error("Connecting a new agency's GoHighLevel failed", error);
    throw new ConnectError("GoHighLevel couldn't be connected. Try again.");
  }
}
