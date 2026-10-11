"use server";

import {
  ClientAccessDenied,
  NotOperator,
  operatorsFromEnv,
  requireAgencyManager,
  selectClient,
  setComped,
  setMemberClients,
} from "@locus/auth";
import { ConnectError, importStaffAccess, syncLocations } from "@locus/connect";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connectDeps } from "@/lib/connect";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { safeNext } from "@/lib/next-path";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** Better Auth's API errors carry a readable message in `body.message`. */
function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const body = (error as { body?: { message?: unknown } }).body;
    if (typeof body?.message === "string") return body.message;
    if (error instanceof Error) return error.message;
  }
  return "Something went wrong.";
}

const back = (path: string, error: unknown): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(messageOf(error))}`);

const nextQuery = (next: string) => (next === "/" ? "" : `?next=${encodeURIComponent(next)}`);

export async function signUp(form: FormData) {
  const next = safeNext(form.get("next"), "/onboarding");
  try {
    await locus().auth.api.signUpEmail({
      body: {
        name: text(form, "name"),
        email: text(form, "email"),
        password: String(form.get("password") ?? ""),
        callbackURL: next,
      },
    });
  } catch (error) {
    back(`/sign-up${nextQuery(next)}`, error);
  }
  redirect("/sign-up?sent=1");
}

export async function signIn(form: FormData) {
  const next = safeNext(form.get("next"), "/");
  try {
    await locus().auth.api.signInEmail({
      body: { email: text(form, "email"), password: String(form.get("password") ?? "") },
      headers: await headers(),
    });
  } catch (error) {
    back(`/sign-in${nextQuery(next)}`, error);
  }
  redirect(next);
}

export async function signOut() {
  await locus().auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "agency"}-${crypto.randomUUID().slice(0, 6)}`;
}

/** A new agency, owned by the signed-in user and made their active one. */
export async function createAgency(form: FormData) {
  const name = text(form, "name");
  try {
    const requestHeaders = await headers();
    const agency = await locus().auth.api.createOrganization({
      body: { name, slug: slugify(name) },
      headers: requestHeaders,
    });
    if (!agency) throw new Error("The agency could not be created.");
    await locus().auth.api.setActiveOrganization({
      body: { organizationId: agency.id },
      headers: requestHeaders,
    });
  } catch (error) {
    back("/onboarding", error);
  }
  redirect("/");
}

/**
 * Makes a client the session's active one. The only place a client id comes from the user —
 * `selectClient` checks the member may work on it before storing it on the session.
 */
export async function chooseClient(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  try {
    await selectClient(locus().db, sessionContext(current), text(form, "locationId"));
  } catch (error) {
    if (error instanceof ClientAccessDenied) back("/clients", error);
    throw error;
  }
  redirect("/");
}

/** Invites someone to the active agency. Better Auth lets owners and admins do this. */
export async function inviteMember(form: FormData) {
  const role = text(form, "role") === "admin" ? "admin" : "member";
  try {
    await locus().auth.api.createInvitation({
      body: { email: text(form, "email"), role },
      headers: await headers(),
    });
  } catch (error) {
    back("/team", error);
  }
  redirect("/team?invited=1");
}

/** Accepts an invitation (verified email required) and switches to that agency. */
export async function acceptInvite(form: FormData) {
  const invitationId = text(form, "invitationId");
  try {
    const requestHeaders = await headers();
    const accepted = await locus().auth.api.acceptInvitation({
      body: { invitationId },
      headers: requestHeaders,
    });
    const organizationId = accepted?.invitation.organizationId;
    if (!organizationId) throw new Error("The invitation could not be accepted.");
    await locus().auth.api.setActiveOrganization({
      body: { organizationId },
      headers: requestHeaders,
    });
  } catch (error) {
    back(`/invite/${encodeURIComponent(invitationId)}`, error);
  }
  redirect("/");
}

/** Replaces the clients a member may work on. `setMemberClients` checks the caller. */
export async function saveMemberClients(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  try {
    await setMemberClients(
      locus().db,
      sessionContext(current),
      text(form, "memberId"),
      form.getAll("locationId").map(String),
    );
  } catch (error) {
    if (error instanceof ClientAccessDenied) back("/team", error);
    throw error;
  }
  redirect("/team?saved=1");
}

/** Picks up sub-accounts installed in GHL since the last sync. Owners and admins only. */
export async function syncClients() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fconnect");
  let result = { added: 0, reactivated: 0 };
  try {
    const { organizationId } = await requireAgencyManager(locus().db, sessionContext(current));
    result = await syncLocations(connectDeps(), organizationId);
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof ConnectError)
      back("/connect", error);
    throw error;
  }
  redirect(`/connect?synced=${result.added}&reactivated=${result.reactivated}`);
}

/** Copies each staff member's client list from GHL, once. Owners and admins only. */
export async function importStaff() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fteam");
  let query = "";
  try {
    const report = await importStaffAccess(connectDeps(), sessionContext(current));
    query = `imported=${report.updated.length}&ghlOnly=${report.ghlOnly}`;
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof ConnectError) back("/team", error);
    throw error;
  }
  redirect(`/team?${query}`);
}

/** Comps an agency or ends its comp. The deployment's operators only. */
export async function setAgencyComped(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Foperator");
  try {
    await setComped(
      locus().db,
      sessionContext(current),
      operatorsFromEnv(),
      text(form, "organizationId"),
      text(form, "comped") === "true",
    );
  } catch (error) {
    if (error instanceof NotOperator) back("/operator", error);
    throw error;
  }
  redirect("/operator");
}
