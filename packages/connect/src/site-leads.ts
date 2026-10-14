import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { consumeAttempt } from "@locus/auth";
import { location, site } from "@locus/db/control";
import {
  type GhlOperation,
  type GhlRateLimiter,
  type GhlSession,
  ghlRequest,
  sharedRateLimiter,
} from "@locus/ghl";
import { operationById } from "@locus/skills";
import { eq } from "drizzle-orm";
import { agencyToken, type ConnectDeps } from "./agency.ts";
import { mintLocationToken } from "./ghl-oauth.ts";

// A published site's lead form, into the client's GHL sub-account.
//
// The visitor's browser posts to the site's own `/api/lead` route (same origin, no CORS); that
// route forwards the body, server to server, to Locus at `/api/sites/<siteId>/leads`. The site
// id is public and baked into the site when it is published (`lib/locus.ts`); it is not a
// credential. Which client the lead belongs to is read from the site's registry row, never from
// the request: the request names a site, and only a published site of an active client is
// accepted. No token ever reaches the site's code — Locus mints the sub-account token here, for
// this request only.
//
// What the visitor typed is untrusted. It is validated and length-limited here, goes to GHL as
// contact fields and one note, and never reaches an agent from this path (an agent that later
// reads the contact through GHL gets it through the harness's prompt-injection screen).
//
// Spam: a honeypot field, a minimum time between the form appearing and being sent, and fixed-
// window limits per site and per visitor IP (counted in the control database, like sign-ins).
// A captcha (Turnstile) is not wired yet; it would be checked here, before the limits.

export type SiteLeadDeps = Pick<ConnectDeps, "db" | "secrets" | "ghl" | "http" | "now"> & {
  /** GHL's per-client burst budget; defaults to the process-wide one. */
  rateLimiter?: GhlRateLimiter;
  limits?: Partial<SiteLeadLimits>;
};

export interface SiteLeadLimits {
  /** Submissions one site accepts per window, from anyone. */
  perSite: { max: number; windowMs: number };
  /** Submissions one visitor IP may send to one site per window. */
  perIp: { max: number; windowMs: number };
  /** Below this many milliseconds from the form appearing to it being sent, it's a bot. */
  minFillMs: number;
}

const MINUTE = 60_000;

// Windows stay within an hour: `consumeAttempt` sweeps keys older than its longest window.
export const SITE_LEAD_LIMITS: SiteLeadLimits = {
  perSite: { max: 60, windowMs: 60 * MINUTE },
  perIp: { max: 5, windowMs: 10 * MINUTE },
  minFillMs: 3_000,
};

/** The largest request body Locus reads, in bytes. */
export const MAX_LEAD_BODY_BYTES = 16 * 1024;

/** The hidden field people never see and bots fill in. */
export const LEAD_HONEYPOT_FIELD = "fax";
/** Milliseconds from the form appearing to it being sent, measured by the form. */
export const LEAD_ELAPSED_FIELD = "elapsedMs";

/** Each known field's longest accepted value. */
const FIELD_LIMITS = {
  name: 120,
  firstName: 60,
  lastName: 60,
  email: 254,
  phone: 32,
  companyName: 120,
  message: 5_000,
  form: 40,
  page: 300,
} as const;
type KnownField = keyof typeof FIELD_LIMITS;

/** Other fields a form may add; they go into the note, never into a GHL field. */
const MAX_EXTRA_FIELDS = 10;
const MAX_EXTRA_KEY = 40;
const MAX_EXTRA_VALUE = 1_000;

/**
 * Fields that would name a tenant, a record or a GHL setting. Locus sets these itself or not at
 * all, so a request that sends one is refused outright. Compared lower-cased without `_`/`-`.
 */
const REFUSED_FIELDS = new Set([
  "locationid",
  "companyid",
  "altid",
  "alttype",
  "contactid",
  "siteid",
  "userid",
  "assignedto",
  "tags",
  "source",
  "customfields",
  "dnd",
  "dndsettings",
]);

export type SiteLeadResult =
  | { status: 200; body: { ok: true } }
  | { status: 400 | 404 | 413 | 502; body: { error: string } }
  | { status: 429; body: { error: string }; retryAfterSeconds: number };

const refuse = (status: 400 | 404 | 413 | 502, error: string): SiteLeadResult => ({
  status,
  body: { error },
});
const ACCEPTED: SiteLeadResult = { status: 200, body: { ok: true } };

const NOT_CONNECTED = "This form isn't connected.";
const NOT_SENT = "We couldn't send that just now. Please try again.";

export interface SiteLeadInput {
  /** From the URL; a public identifier, not a credential. */
  siteId: string;
  /** The request body as text, at most `MAX_LEAD_BODY_BYTES`. */
  raw: string;
  /** The visitor's address as the site's route saw it, if any. Only used for the per-IP limit. */
  visitorIp: string | null;
}

interface Lead {
  fields: Partial<Record<KnownField, string>>;
  extras: [string, string][];
}

/**
 * Takes one submission from a published site's form and puts it in the site's client's GHL
 * sub-account: upserts the contact, tags it, and adds the message as a note. Every refusal is a
 * short, fixed message; nothing from GHL or the database reaches the visitor.
 */
export async function submitSiteLead(
  deps: SiteLeadDeps,
  input: SiteLeadInput,
): Promise<SiteLeadResult> {
  const limits = { ...SITE_LEAD_LIMITS, ...deps.limits };
  if (Buffer.byteLength(input.raw) > MAX_LEAD_BODY_BYTES) {
    return refuse(413, "That's too much to send. Please shorten your message.");
  }
  let body: unknown;
  try {
    body = JSON.parse(input.raw);
  } catch {
    return refuse(400, "That form didn't send anything we could read.");
  }
  const parsed = parseLead(body);
  if ("error" in parsed) return refuse(400, parsed.error);
  const { lead, honeypot, elapsedMs } = parsed;

  // The site, and through it the client. Unknown, unpublished and suspended look the same.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(input.siteId)) return refuse(404, NOT_CONNECTED);
  const [row] = await deps.db
    .select({ site, location })
    .from(site)
    .innerJoin(location, eq(site.locationId, location.id))
    .where(eq(site.id, input.siteId));
  if (!row || row.site.status === "draft" || row.location.status !== "active") {
    return refuse(404, NOT_CONNECTED);
  }

  // Every attempt at a real site counts, bots included.
  const now = deps.now?.() ?? Date.now();
  const checks = [consumeAttempt(deps.db, `site-lead|site|${row.site.id}`, limits.perSite, now)];
  const ip = input.visitorIp?.trim();
  if (ip && isIP(ip)) {
    // Kept hashed: the counter only needs to tell visitors apart.
    const who = createHash("sha256").update(ip).digest("hex").slice(0, 32);
    checks.push(consumeAttempt(deps.db, `site-lead|ip|${row.site.id}|${who}`, limits.perIp, now));
  }
  let wait = 0;
  for (const result of await Promise.all(checks)) {
    if (!result.allowed) wait = Math.max(wait, result.retryAfterSeconds);
  }
  if (wait > 0) {
    return {
      status: 429,
      body: { error: "Too many messages from here. Please try again later." },
      retryAfterSeconds: wait,
    };
  }

  // A bot: say it went, send nothing, so it learns nothing.
  if (honeypot || elapsedMs === null || elapsedMs < limits.minFillMs) return ACCEPTED;

  try {
    await sendToGhl(deps, row.location, lead);
  } catch (error) {
    // Logged without the visitor's details or GHL's text, which may echo them.
    const { name, status, operationId } = error as {
      name?: string;
      status?: number;
      operationId?: string;
    };
    console.error(
      `Site lead for site ${row.site.id} failed: ${name ?? "Error"}${operationId ? ` ${operationId}` : ""}${status ? ` ${status}` : ""}`,
    );
    return refuse(502, NOT_SENT);
  }
  return ACCEPTED;
}

type Parsed = { lead: Lead; honeypot: boolean; elapsedMs: number | null } | { error: string };

/** Validates the body's shape and lengths. Returns a visitor-facing message when it can't. */
export function parseLead(body: unknown): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "That form didn't send anything we could read." };
  }
  const fields: Lead["fields"] = {};
  const extras: Lead["extras"] = [];
  let honeypot = false;
  let elapsedMs: number | null = null;

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (REFUSED_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ""))) {
      return { error: "That form sends a field Locus doesn't accept." };
    }
    if (key === LEAD_HONEYPOT_FIELD) {
      honeypot = typeof value === "string" ? value.trim() !== "" : value != null;
      continue;
    }
    if (key === LEAD_ELAPSED_FIELD) {
      const n = typeof value === "string" ? Number(value) : value;
      elapsedMs = typeof n === "number" && Number.isFinite(n) ? n : null;
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") return { error: "Each answer must be text." };
    const text = clean(value, key === "message");
    if (!text) continue;
    if (Object.hasOwn(FIELD_LIMITS, key)) {
      const limit = FIELD_LIMITS[key as KnownField];
      if (text.length > limit) return { error: `That ${label(key)} is too long.` };
      fields[key as KnownField] = text;
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || key.length > MAX_EXTRA_KEY) {
      return { error: "That form sends a field Locus doesn't accept." };
    }
    if (text.length > MAX_EXTRA_VALUE) return { error: "One of those answers is too long." };
    extras.push([key, text]);
    if (extras.length > MAX_EXTRA_FIELDS) return { error: "That form sends too many fields." };
  }

  if (fields.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return { error: "Please enter a valid email address." };
  }
  if (fields.phone !== undefined) {
    const digits = fields.phone.replace(/\D/g, "").length;
    if (!/^[0-9+().\-\s]+$/.test(fields.phone) || digits < 7 || digits > 15) {
      return { error: "Please enter a valid phone number." };
    }
  }
  if (!fields.email && !fields.phone) {
    return { error: "Please enter an email address or phone number." };
  }
  if (fields.form !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(fields.form)) {
    return { error: "That form sends a field Locus doesn't accept." };
  }
  return { lead: { fields, extras }, honeypot, elapsedMs };
}

const label = (key: string) =>
  ({ firstName: "first name", lastName: "last name", companyName: "company name" })[key] ?? key;

/** Trims and drops control characters; a message keeps its line breaks. */
function clean(value: string, multiline: boolean): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return value.replace(/\r\n?/g, "\n").replace(control, "").trim();
}

function operation(id: string): GhlOperation {
  const op = operationById(id);
  if (!op) throw new Error(`The skill catalog is missing ${id}`);
  return op;
}

/** The tag every website lead gets, and the per-form one. */
export const leadTags = (form: string) => ["website lead", `website form: ${form}`];

async function sendToGhl(
  deps: SiteLeadDeps,
  client: typeof location.$inferSelect,
  lead: Lead,
): Promise<void> {
  // The sub-account comes from the site's registry row; the session is for this request only.
  const agency = await agencyToken(deps, client.organizationId);
  const session: GhlSession = {
    token: await mintLocationToken(agency, client.ghlLocationId, deps.http),
    tokenKind: "location",
    locationId: client.ghlLocationId,
    companyId: agency.companyId,
  };
  const options = { ...deps.http, rateLimiter: deps.rateLimiter ?? sharedRateLimiter };
  const { fields, extras } = lead;
  const form = fields.form ?? "contact";

  const contact: Record<string, unknown> = { source: `Website form (${form})` };
  for (const key of ["name", "firstName", "lastName", "email", "phone", "companyName"] as const) {
    if (fields[key]) contact[key] = fields[key];
  }
  // `tags` on upsert would replace the contact's tags, so they're added separately.
  const upserted = await ghlRequest<{ contact?: { id?: string } }>(
    operation("contacts.upsert-contact"),
    session,
    { body: contact },
    options,
  );
  const contactId = upserted.contact?.id;
  if (!contactId) throw new Error("GoHighLevel's upsert response had no contact id");

  await ghlRequest(
    operation("contacts.add-tags"),
    session,
    { path: { contactId }, body: { tags: leadTags(form) } },
    options,
  );

  const lines: string[] = [];
  if (fields.message) lines.push(fields.message, "");
  for (const [key, value] of extras) lines.push(`${key}: ${value}`);
  if (fields.page) lines.push(`Page: ${fields.page}`);
  if (lines.length > 0) {
    await ghlRequest(
      operation("contacts.create-note"),
      session,
      {
        path: { contactId },
        body: { title: `Website form: ${form}`, body: lines.join("\n").trim() },
      },
      options,
    );
  }
}
