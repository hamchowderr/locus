"use server";

import {
  ClientAccessDenied,
  NotOperator,
  operatorsFromEnv,
  requireAgencyManager,
  resolveActiveClient,
  selectClient,
  setComped,
  setMemberClients,
} from "@locus/auth";
import {
  attachSiteDomain,
  ConnectError,
  importStaffAccess,
  linkHostProject,
  refusedQuery,
  removeSiteDomain,
  type SyncResult,
  syncLocations,
  unlinkHostProject,
} from "@locus/connect";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { baseUrl, connectDeps } from "@/lib/connect";
import { publishDeps, siteDeps } from "@/lib/hosts";
import { billingEnabled, currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { safeNext } from "@/lib/next-path";
import {
  ACTIVE_SITE_COOKIE,
  chooseActiveSite,
  createClientSite,
  deleteClientSite,
  publishLatestVersion,
  SiteInputError,
} from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { giveSiteProject, giveSiteRepo } from "@/lib/site-publish";

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
      // The client's IP, for the sign-up rate limit.
      headers: await headers(),
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
    // Signing in with the right password resends the verification link (`sendOnSignIn`).
    const unverified =
      (error as { body?: { code?: unknown } })?.body?.code === "EMAIL_NOT_VERIFIED";
    back(
      `/sign-in${nextQuery(next)}`,
      unverified ? new Error("Your email isn't verified yet. We've sent you a new link.") : error,
    );
  }
  redirect(next);
}

/**
 * Emails a reset link. The page says the same whether or not the address has an account, and a
 * failed send is logged rather than shown. (Response time can still differ, as for sign-up.)
 */
export async function requestPasswordReset(form: FormData) {
  try {
    await locus().auth.api.requestPasswordReset({
      body: { email: text(form, "email"), redirectTo: "/reset-password" },
    });
  } catch (error) {
    console.error(`Password reset request failed: ${messageOf(error)}`);
  }
  redirect("/forgot-password?sent=1");
}

/** Sets the new password from the emailed link's token; every session is signed out. */
export async function resetPassword(form: FormData) {
  const token = text(form, "token");
  const password = String(form.get("password") ?? "");
  const retry = `/reset-password?token=${encodeURIComponent(token)}`;
  if (password !== String(form.get("confirm") ?? "")) {
    back(retry, new Error("The two passwords don't match."));
  }
  try {
    await locus().auth.api.resetPassword({ body: { token, newPassword: password } });
  } catch (error) {
    const invalid = (error as { body?: { code?: unknown } })?.body?.code === "INVALID_TOKEN";
    if (invalid) redirect("/reset-password?error=INVALID_TOKEN");
    back(retry, error);
  }
  redirect("/sign-in?reset=1");
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
  let result: SyncResult = { added: 0, reactivated: 0, unchanged: 0 };
  try {
    const { organizationId } = await requireAgencyManager(locus().db, sessionContext(current));
    result = await syncLocations(connectDeps(), organizationId);
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof ConnectError)
      back("/connect", error);
    throw error;
  }
  redirect(
    `/connect?synced=${result.added}&reactivated=${result.reactivated}${refusedQuery(result)}`,
  );
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

/**
 * Sends an owner or admin to Stripe Checkout for a plan. The agency is the session's active
 * one; the Stripe plugin's `authorizeReference` refuses anything else.
 */
export async function subscribe(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbilling");
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");
  if (!billingEnabled()) back("/billing", new Error("Billing isn't set up on this deployment."));
  let url = "";
  try {
    const res = await locus().auth.api.upgradeSubscription({
      body: {
        plan: text(form, "plan"),
        referenceId: organizationId,
        customerType: "organization",
        successUrl: `${baseUrl()}/billing?subscribed=1`,
        cancelUrl: `${baseUrl()}/billing`,
        disableRedirect: true,
      },
      headers: await headers(),
    });
    url = res.url ?? "";
  } catch (error) {
    back("/billing", error);
  }
  if (!url) back("/billing", new Error("Stripe didn't return a checkout page. Try again."));
  redirect(url);
}

/** Opens Stripe's billing portal for the session's agency. Owners and admins only. */
export async function openBillingPortal() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbilling");
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");
  let url = "";
  try {
    const res = await locus().auth.api.createBillingPortal({
      body: {
        referenceId: organizationId,
        customerType: "organization",
        returnUrl: `${baseUrl()}/billing`,
        disableRedirect: true,
      },
      headers: await headers(),
    });
    url = res.url ?? "";
  } catch (error) {
    back("/billing", error);
  }
  if (!url) back("/billing", new Error("Stripe didn't open the billing portal. Try again."));
  redirect(url);
}

/**
 * Runs a change to the active client's site, then returns to the Sites page. The client is the
 * session's, never the form's; the site and project ids from the form are checked against it.
 */
async function siteAction(
  change: (
    ctx: ReturnType<typeof sessionContext>,
    client: Awaited<ReturnType<typeof resolveActiveClient>>,
  ) => Promise<unknown>,
  notConfigured = "Vercel isn't set up here yet.",
) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  try {
    await change(ctx, await resolveActiveClient(locus().db, ctx));
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof ConnectError) back("/sites", error);
    if (error instanceof NotConfigured) back("/sites", new Error(notConfigured));
    throw error;
  }
  // The redirect lands on the page the form was on, so drop its cached render.
  revalidatePath("/sites");
  redirect("/sites");
}

/** Makes a project on the agency's Vercel team the active client's site. */
export async function linkSiteProject(form: FormData) {
  await siteAction((ctx, client) =>
    linkHostProject(siteDeps(), ctx, client, { projectId: text(form, "projectId") }),
  );
}

/** Adds a domain to one of the active client's sites. */
export async function addSiteDomain(form: FormData) {
  await siteAction((ctx, client) =>
    attachSiteDomain(siteDeps(), ctx, client, {
      siteId: text(form, "siteId"),
      domain: text(form, "domain"),
    }),
  );
}

/** Takes the domain off one of the active client's sites. */
export async function deleteSiteDomain(form: FormData) {
  await siteAction((ctx, client) =>
    removeSiteDomain(siteDeps(), ctx, client, text(form, "siteId")),
  );
}

/**
 * Creates a site for the active client and starts it from a template, so version 1 exists.
 * The client is the session's (after the staff check), never the form's.
 */
export async function createSite(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    const { siteId } = await createClientSite(siteBuilderDeps(), ctx, client, {
      name: text(form, "name"),
      kind: text(form, "kind"),
      templateId: text(form, "templateId"),
    });
    // The site just made is the one the person means to build next, in the chat too. The site
    // exists either way, so failing to choose it doesn't fail the creation.
    try {
      await rememberActiveSite(await chooseActiveSite(locus().db, ctx, client, siteId));
    } catch (error) {
      console.error("createSite: could not choose the new site", error);
    }
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back("/sites", error);
    }
    if (error instanceof NotConfigured) {
      back("/sites", new Error("Client databases aren't set up here yet."));
    }
    throw error;
  }
  redirect("/sites?created=1");
}

/**
 * Deletes one of the active client's sites, with everything Locus keeps for it; its repository
 * stays. Owners and admins only; the client is the session's, and a site with a Vercel project
 * or domain is refused (`deleteClientSite`).
 */
export async function deleteSite(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  if (form.get("confirm") !== "yes") {
    back("/sites", new Error("Tick the box to confirm you want the site deleted."));
  }
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    await deleteClientSite(siteBuilderDeps(), ctx, client, text(form, "siteId"));
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back("/sites", error);
    }
    if (error instanceof NotConfigured) {
      back("/sites", new Error("Client databases aren't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites");
  redirect("/sites?deleted=1");
}

/**
 * Picks the site the site builder works on, for this browser. The site is checked against the
 * session's client here, and again by the chat API (`resolveActiveSiteId`) and on every tool
 * call; the cookie only names it.
 */
export async function chooseSite(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  let siteId = "";
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    siteId = await chooseActiveSite(locus().db, ctx, client, text(form, "siteId"));
  } catch (error) {
    if (error instanceof ClientAccessDenied) back("/sites", error);
    if (error instanceof NotConfigured) back("/sites", new Error("Locus isn't set up here yet."));
    throw error;
  }
  await rememberActiveSite(siteId);
  redirect("/sites?chosen=1");
}

/** Names the chosen site in this browser's cookie (the session column is the source of truth). */
async function rememberActiveSite(siteId: string) {
  (await cookies()).set(ACTIVE_SITE_COOKIE, siteId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

/** Takes a linked Vercel project off the active client. */
export async function unlinkSiteProject(form: FormData) {
  await siteAction((ctx, client) =>
    unlinkHostProject(siteDeps(), ctx, client, text(form, "siteId")),
  );
}

/**
 * Gives one of the active client's sites a GitHub repository in the agency's account: a new
 * private one, or an existing empty one the Locus app can see. Owners and admins only.
 */
export async function giveSiteRepository(form: FormData) {
  await siteAction(
    (ctx, client) =>
      giveSiteRepo(publishDeps(), ctx, client, {
        siteId: text(form, "siteId"),
        repo: text(form, "repo"),
        name: text(form, "name"),
      }),
    "Publishing to GitHub isn't set up here yet.",
  );
}

/**
 * Sends one of the active client's sites' latest saved version to its repository, so Vercel
 * deploys it. The client is the session's (after the staff check), never the form's.
 */
export async function publishSite(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  let done: string;
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    const { version } = await publishLatestVersion(
      siteBuilderDeps(),
      ctx,
      client,
      text(form, "siteId"),
    );
    done = `published=${version}${form.get("deploys") === "yes" ? "&deploys=1" : ""}`;
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back("/sites", error);
    }
    if (error instanceof NotConfigured) {
      back("/sites", new Error("Publishing to GitHub isn't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites");
  redirect(`/sites?${done}`);
}

/** Gives one of the active client's sites a Vercel project that builds its repository. */
export async function giveSiteVercelProject(form: FormData) {
  await siteAction(
    (ctx, client) => giveSiteProject(publishDeps(), ctx, client, text(form, "siteId")),
    "Publishing to GitHub and Vercel isn't set up here yet.",
  );
}
