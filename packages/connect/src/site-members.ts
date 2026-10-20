import { type SiteFileAnswer, type SiteFilesDeps, siteFor } from "./site-files.ts";
import {
  consumeSiteLimits,
  logGhlFailure,
  parseLead,
  type SiteLeadLimits,
  sendToGhl,
  siteGhl,
} from "./site-leads.ts";

// Members who sign up on an app-style site become contacts in the site's client's HighLevel
// sub-account, like a form lead: the site's own sign-up code (Better Auth, on its server) tells
// Locus with the site's key, and Locus finds or creates the contact, filling only blank details,
// tagged as a sign-up. Which sub-account comes from the site's registry row, never the request.

/** Sign-ups one site reports, on top of GHL's own per-client budget. */
export const SITE_MEMBER_LIMITS: Pick<SiteLeadLimits, "perIp" | "perSiteBurst" | "perSite"> = {
  perSite: { max: 100, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 10, windowMs: 60_000 },
  perIp: { max: 5, windowMs: 10 * 60_000 },
};

/** The form name sign-ups carry in HighLevel: tags `website lead`, `website form: sign-up`. */
export const SIGN_UP_FORM = "sign-up";

const refuse = (status: 400 | 401 | 403 | 502, error: string): SiteFileAnswer => ({
  status,
  body: { error },
});

/**
 * A member who just signed up on a published app-style site: `body` is `{ email, name? }`. The
 * site sends it from its server once the account exists; a failure here never undoes the
 * sign-up, so the site only logs it.
 */
export async function siteMemberSignedUp(
  deps: SiteFilesDeps & { memberLimits?: Partial<typeof SITE_MEMBER_LIMITS> },
  input: { siteId: string; authorization: string | null; body: unknown; visitorIp: string | null },
): Promise<SiteFileAnswer> {
  const row = await siteFor(deps, input.siteId, input.authorization);
  if (!row) return refuse(401, "This site can't send sign-ups.");
  const given = (input.body ?? {}) as { email?: unknown; name?: unknown };
  const parsed = parseLead({
    email: given.email,
    ...(typeof given.name === "string" && given.name.trim() ? { name: given.name } : {}),
    form: SIGN_UP_FORM,
  });
  if ("error" in parsed || !parsed.lead.fields.email) {
    return refuse(400, "Send the member's email.");
  }
  const limits = { ...SITE_MEMBER_LIMITS, ...deps.memberLimits };
  const now = deps.now?.() ?? Date.now();
  const wait = await consumeSiteLimits(deps, row.site.id, input.visitorIp, limits, now, "member");
  if (wait !== null) {
    return {
      status: 429,
      body: { error: "Too many sign-ups just now." },
      retryAfterSeconds: wait,
    };
  }
  try {
    const ghl = await siteGhl(deps, row.location);
    if (!ghl.scopes.includes("contacts.write")) {
      return refuse(403, "This site's HighLevel connection can't add contacts.");
    }
    await sendToGhl(ghl, { fields: parsed.lead.fields, extras: [] });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    logGhlFailure(`Site sign-up for site ${row.site.id}`, error);
    return refuse(502, "The sign-up couldn't be sent to HighLevel just now.");
  }
}
