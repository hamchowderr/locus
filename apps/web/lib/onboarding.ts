import { rememberAgency, startTrial } from "@locus/auth";
import {
  beginOnboarding,
  ConnectError,
  connectAgencyGrant,
  exchangeCode,
  inspectGrant,
  onboardingOpen,
  type SyncResult,
} from "@locus/connect";
import { member } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { connectDeps } from "./connect.ts";
import { currentSession, locus, sessionContext } from "./locus.ts";

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
  if (claimedBy) {
    const [mine] = await locus()
      .db.select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, claimedBy), eq(member.userId, current.user.id)));
    throw new ConnectError(
      mine
        ? "This GoHighLevel agency is already in Locus, in an agency you belong to. Switch to it from the menu."
        : "This GoHighLevel agency is already connected to another Locus agency. Ask its owner to invite you.",
    );
  }

  const requestHeaders = await headers();
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
  return connectAgencyGrant(
    deps,
    { ...sessionContext(current), activeOrganizationId: agency.id, activeLocationId: null },
    grant,
  );
}
