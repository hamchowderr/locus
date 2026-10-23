"use server";

import {
  authorizeClient,
  ClientAccessDenied,
  CREDIT,
  MAX_OVERAGE_CREDITS,
  NotOperator,
  OVERAGE_CENTS_PER_CREDIT,
  operatorsFromEnv,
  rememberAgency,
  requireAgencyManager,
  resolveActiveClient,
  selectClient,
  setComped,
  setMemberClients,
  setSiteAccess,
  setSiteBuilder,
  setUsageOverage,
} from "@locus/auth";
import {
  attachSiteDomain,
  ConnectError,
  importStaffAccess,
  linkHostProject,
  refusedQuery,
  removeSiteDomain,
  type SyncResult,
  setSiteFolder,
  syncLocations,
  unlinkHostProject,
} from "@locus/connect";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { baseUrl, connectDeps } from "@/lib/connect";
import { prepareExtraUsage, sendExtraUsage } from "@/lib/extra-usage";
import { publishDeps, siteDeps } from "@/lib/hosts";
import { billingEnabled, currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { safeNext, sitesReturn } from "@/lib/next-path";
import {
  ACTIVE_SITE_COOKIE,
  chooseActiveSite,
  copyClientSite,
  createClientSite,
  deleteClientSite,
  publishLatestVersion,
  SiteInputError,
} from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { giveSiteProject, giveSiteRepoAndPublish } from "@/lib/site-publish";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** An uploaded file's bytes and type, or null when the field was left empty. */
async function uploaded(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size === 0) return null;
  return { bytes: new Uint8Array(await value.arrayBuffer()), mediaType: value.type };
}

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
    const current = await currentSession();
    if (current) await rememberAgency(locus().db, current.user.id, agency.id);
  } catch (error) {
    back("/onboarding", error);
  }
  redirect("/");
}

/**
 * Makes another of the user's agencies the active one. Better Auth refuses an agency the user
 * isn't a member of; the session's sub-account and site belong to the old agency and are
 * dropped (the session update hook), so the member picks a sub-account again.
 */
export async function switchAgency(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  const organizationId = text(form, "organizationId");
  if (organizationId === current.session.activeOrganizationId) redirect("/");
  try {
    await locus().auth.api.setActiveOrganization({
      body: { organizationId },
      headers: await headers(),
    });
    await rememberAgency(locus().db, current.user.id, organizationId);
  } catch (error) {
    back("/clients", error);
  }
  revalidatePath("/", "layout");
  redirect("/clients");
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
  // The menu shows the chosen sub-account, so every page's layout is drawn again.
  revalidatePath("/", "layout");
  // The menu's switcher sends the page to stay on; the Sub-accounts page opens the chat.
  redirect(safeNext(form.get("next"), "/chat"));
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
    const current = await currentSession();
    if (current) await rememberAgency(locus().db, current.user.id, organizationId);
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

/**
 * Turns the session agency's extra usage on or off, with a monthly limit in US dollars. Owners
 * and admins only (`setUsageOverage`). Turning it on first adds the metered price to the agency's
 * subscription, so Stripe can bill extra credits from the first one.
 */
export async function setExtraUsage(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbilling");
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");
  const enabled = form.get("enabled") === "on";
  const dollars = Number(text(form, "limitUsd") || "0");
  const credits = Math.floor((dollars * 100) / OVERAGE_CENTS_PER_CREDIT) * CREDIT;
  if (!Number.isFinite(dollars) || dollars < 0 || credits > MAX_OVERAGE_CREDITS) {
    back("/billing", new Error("Enter a monthly limit in dollars, such as 50."));
  }
  let refusal: string | null = null;
  try {
    const ctx = sessionContext(current);
    // Only an owner or admin gets as far as Stripe.
    await requireAgencyManager(locus().db, ctx);
    refusal = enabled ? await prepareExtraUsage(organizationId) : null;
    if (!refusal) await setUsageOverage(locus().db, ctx, { enabled, monthlyCreditLimit: credits });
  } catch (error) {
    back(
      "/billing",
      error instanceof ClientAccessDenied
        ? new Error("Only the agency's owners and admins manage billing.")
        : error,
    );
  }
  if (refusal) back("/billing", new Error(refusal));
  // Usage from before it was turned off is still owed; send it now rather than at the next run.
  if (!enabled) await sendExtraUsage({ organizationId });
  revalidatePath("/billing");
  redirect("/billing?saved=1");
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
 * Runs a change to the active client's site, then returns to the page the form was on (its
 * `returnTo`: the Sites page or one of a site's pages). The client is the session's, never the
 * form's; the site and project ids from the form are checked against it.
 */
async function siteAction(
  form: FormData,
  change: (
    ctx: ReturnType<typeof sessionContext>,
    client: Awaited<ReturnType<typeof resolveActiveClient>>,
  ) => Promise<unknown>,
  notConfigured = "Vercel isn't set up here yet.",
  /** Where to land afterwards, from what the change returned; the form's page by default. */
  landing: (result: unknown, home: string) => string = (_, home) => home,
) {
  const home = sitesReturn(form.get("returnTo"));
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(home)}`);
  const ctx = sessionContext(current);
  let result: unknown;
  try {
    result = await change(ctx, await resolveActiveClient(locus().db, ctx));
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof ConnectError) back(home, error);
    if (error instanceof NotConfigured) back(home, new Error(notConfigured));
    throw error;
  }
  // The redirect lands on the page the form was on, so drop the cached renders of every page
  // that shows sites.
  revalidatePath("/sites", "layout");
  redirect(landing(result, home));
}

/** Makes a project on the agency's Vercel team the active client's site. */
export async function linkSiteProject(form: FormData) {
  await siteAction(form, (ctx, client) =>
    linkHostProject(siteDeps(), ctx, client, { projectId: text(form, "projectId") }),
  );
}

/** Adds a domain to one of the active client's sites. */
export async function addSiteDomain(form: FormData) {
  await siteAction(form, (ctx, client) =>
    attachSiteDomain(siteDeps(), ctx, client, {
      siteId: text(form, "siteId"),
      domain: text(form, "domain"),
    }),
  );
}

/** Takes the domain off one of the active client's sites. */
export async function deleteSiteDomain(form: FormData) {
  await siteAction(form, (ctx, client) =>
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
  let siteId = "";
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    ({ siteId } = await createClientSite(siteBuilderDeps(), ctx, client, {
      name: text(form, "name"),
      kind: text(form, "kind"),
      templateId: text(form, "templateId"),
      description: text(form, "description"),
      goal: text(form, "goal"),
      audience: text(form, "audience"),
      palette: text(form, "palette"),
      fonts: text(form, "fonts"),
      layout: text(form, "layout"),
      pages: form.getAll("pages").map(String),
      referenceUrl: text(form, "referenceUrl"),
      screenshot: await uploaded(form.get("screenshot")),
    }));
    // The site just made is the one the person means to build next, in the chat too. The site
    // exists either way, so failing to choose it doesn't fail the creation.
    try {
      await rememberActiveSite(await chooseActiveSite(locus().db, ctx, client, siteId));
    } catch (error) {
      console.error("createSite: could not choose the new site", error);
    }
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back("/sites/new", error);
    }
    if (error instanceof NotConfigured) {
      back("/sites/new", new Error("Client databases aren't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites", "layout");
  // Straight into the new site, its preview and chat side by side.
  redirect(`/sites/${encodeURIComponent(siteId)}?created=1`);
}

/**
 * Copies one of the active client's sites into a new draft, for this client or another one.
 * The source is the session's client; the target from the form goes through the same staff
 * check as choosing a client, so a member can only copy into clients they work on.
 */
export async function copySite(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites");
  const ctx = sessionContext(current);
  const home = sitesReturn(form.get("returnTo"));
  let elsewhere = false;
  let copy = "";
  try {
    const from = await resolveActiveClient(locus().db, ctx);
    const targetId = text(form, "targetClientId") || from.location.id;
    const to =
      targetId === from.location.id ? from : await authorizeClient(locus().db, ctx, targetId);
    elsewhere = to !== from;
    ({ siteId: copy } = await copyClientSite(
      siteBuilderDeps(),
      ctx,
      from,
      text(form, "siteId"),
      to,
      {
        name: text(form, "name"),
      },
    ));
    if (!elsewhere) {
      try {
        await rememberActiveSite(await chooseActiveSite(locus().db, ctx, from, copy));
      } catch (error) {
        console.error("copySite: could not choose the copy", error);
      }
    }
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back(home, error);
    }
    if (error instanceof NotConfigured) {
      back(home, new Error("Client databases aren't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites", "layout");
  redirect(
    elsewhere ? "/sites?copied=elsewhere" : `/sites/${encodeURIComponent(copy)}?copied=here`,
  );
}

/**
 * Sets which members may only view one of the active client's sites; the rest of the members
 * who work on the client manage it. Owners and admins only.
 */
export async function saveSiteAccess(form: FormData) {
  await siteAction(
    form,
    (ctx, client) =>
      setSiteAccess(
        locus().db,
        ctx,
        client,
        text(form, "siteId"),
        form.getAll("viewOnly").map(String),
      ),
    "Locus isn't set up here yet.",
  );
}

/**
 * Turns the site builder on or off for the clients ticked on the Clients page. Owners and admins
 * only; every client must be the agency's (`setSiteBuilder`).
 */
export async function switchSiteBuilder(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fclients");
  const on = form.get("on") === "yes";
  let changed = 0;
  try {
    changed = await setSiteBuilder(
      locus().db,
      sessionContext(current),
      form.getAll("locationId").map(String),
      on,
    );
  } catch (error) {
    if (error instanceof ClientAccessDenied) back("/clients", error);
    throw error;
  }
  revalidatePath("/clients");
  redirect(`/clients?builder=${on ? "on" : "off"}&changed=${changed}`);
}

/** Files one of the active client's sites under a folder, or under none. */
export async function fileSite(form: FormData) {
  await siteAction(
    form,
    (ctx, client) =>
      setSiteFolder(locus().db, ctx, client, {
        siteId: text(form, "siteId"),
        folder: text(form, "folder"),
      }),
    "Locus isn't set up here yet.",
  );
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
  const home = sitesReturn(form.get("returnTo"));
  if (form.get("confirm") !== "yes") {
    back(home, new Error("Tick the box to confirm you want the site deleted."));
  }
  try {
    const client = await resolveActiveClient(locus().db, ctx);
    await deleteClientSite(siteBuilderDeps(), ctx, client, text(form, "siteId"));
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof SiteInputError) {
      back(home, error);
    }
    if (error instanceof NotConfigured) {
      back(home, new Error("Client databases aren't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites", "layout");
  redirect("/sites?deleted=1");
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
  await siteAction(
    form,
    (ctx, client) => unlinkHostProject(siteDeps(), ctx, client, text(form, "siteId")),
    undefined,
    // A linked project that wasn't made in Locus is the whole site: unlinking removes it, so
    // its own pages are gone.
    () => "/sites",
  );
}

/**
 * Gives one of the active client's sites a GitHub repository in the agency's account: a new
 * private one, or an existing empty one the Locus app can see. Owners and admins only.
 */
export async function giveSiteRepository(form: FormData) {
  await siteAction(
    form,
    (ctx, client) =>
      giveSiteRepoAndPublish(publishDeps(), siteBuilderDeps, ctx, client, {
        siteId: text(form, "siteId"),
        repo: text(form, "repo"),
        name: text(form, "name"),
      }),
    "Publishing to GitHub isn't set up here yet.",
    (result, home) => {
      const { version } = result as Awaited<ReturnType<typeof giveSiteRepoAndPublish>>;
      return version === null ? home : `${home}?published=${version}`;
    },
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
  const home = sitesReturn(form.get("returnTo"));
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
      back(home, error);
    }
    if (error instanceof NotConfigured) {
      back(home, new Error("Publishing to GitHub isn't set up here yet."));
    }
    throw error;
  }
  revalidatePath("/sites", "layout");
  redirect(`${home}?${done}`);
}

/** Gives one of the active client's sites a Vercel project that builds its repository. */
export async function giveSiteVercelProject(form: FormData) {
  await siteAction(
    form,
    (ctx, client) => giveSiteProject(publishDeps(), ctx, client, text(form, "siteId")),
    "Publishing to GitHub and Vercel isn't set up here yet.",
  );
}
