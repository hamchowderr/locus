import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { consumeAttempt } from "@locus/auth";
import { openTenantDb, type TenantDb, type TenantProvisioner } from "@locus/db";
import { location, site } from "@locus/db/control";
import { siteLeadDay } from "@locus/db/tenant";
import {
  GhlError,
  type GhlOperation,
  type GhlRateLimiter,
  type GhlSession,
  ghlRequest,
  sharedRateLimiter,
} from "@locus/ghl";
import { operationById } from "@locus/skills";
import { eq, sql } from "drizzle-orm";
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
// Spam: a honeypot field and a minimum time between the form appearing and being sent, checked
// first so junk costs nothing; then fixed-window limits, counted in the control database like
// sign-ins: a tight one per visitor IP, and a short burst guard plus a high hourly ceiling per
// site. The visitor IP is only a hint (the site's route passes it on, and a caller can say
// anything), so the per-site limits are kept high enough that spoofed IPs can't easily switch a
// site's forms off. A captcha (Turnstile, bead locus-ptq.15) is the real fix for that; it would
// be checked here, before the limits.
//
// What reached GHL, or failed to, is counted per site and day in the client's own database
// (`countSiteLead`), so the Sites page can show forms working.

export type SiteLeadDeps = Pick<ConnectDeps, "db" | "secrets" | "ghl" | "http" | "now"> &
  Partial<Pick<ConnectDeps, "provisioner">> & {
    /** GHL's per-client burst budget; defaults to the process-wide one. */
    rateLimiter?: GhlRateLimiter;
    limits?: Partial<SiteLeadLimits>;
    /**
     * The server-side key visitor IPs are hashed with (HMAC-SHA256), so a stored counter key can't
     * be turned back into an address by hashing every IP. Never logged or sent anywhere.
     */
    ipHashKey: Uint8Array;
    /** How long the visitor waits for a lead to be counted; `COUNT_TIMEOUT_MS` by default. */
    countTimeoutMs?: number;
  };

/** The longest a lead's count may hold up the visitor's answer. */
export const COUNT_TIMEOUT_MS = 2_000;

/** What happened to a lead that got past the spam checks and limits. */
export type SiteLeadOutcome = "delivered" | "failed";

export interface SiteLeadLimits {
  /** Submissions one site accepts per window, from anyone: a high ceiling, logged when hit. */
  perSite: { max: number; windowMs: number };
  /** A short burst guard per site, from anyone. */
  perSiteBurst: { max: number; windowMs: number };
  /** Submissions one visitor IP may send to one site per window. */
  perIp: { max: number; windowMs: number };
  /** Below this many milliseconds from the form appearing to it being sent, it's a bot. */
  minFillMs: number;
}

const MINUTE = 60_000;

// Windows stay within an hour: `consumeAttempt` sweeps keys older than its longest window.
export const SITE_LEAD_LIMITS: SiteLeadLimits = {
  perSite: { max: 300, windowMs: 60 * MINUTE },
  perSiteBurst: { max: 20, windowMs: MINUTE },
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
  /** The request body as text (see `readLeadBody`), at most `MAX_LEAD_BODY_BYTES`. */
  raw: string;
  /**
   * The visitor's address as the site's route says it saw it, if any. Caller-controlled: trusted
   * only for the per-IP limit, never for anything else.
   */
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

  // A bot: say it went, send nothing, so it learns nothing. Before any limit, so junk never uses
  // up a real visitor's or the site's allowance.
  if (honeypot || elapsedMs === null || elapsedMs < limits.minFillMs) return ACCEPTED;

  const now = deps.now?.() ?? Date.now();
  const tooMany = (retryAfterSeconds: number): SiteLeadResult => ({
    status: 429,
    body: { error: "Too many messages from here. Please try again later." },
    retryAfterSeconds,
  });
  const ip = input.visitorIp?.trim();
  if (ip && isIP(ip)) {
    // The IP header is a hint, trusted only for this limit. Kept as a keyed hash: the counter
    // only needs to tell visitors apart.
    const who = hashVisitorIp(deps.ipHashKey, ip);
    const perIp = await consumeAttempt(
      deps.db,
      `site-lead|ip|${row.site.id}|${who}`,
      limits.perIp,
      now,
    );
    if (!perIp.allowed) return tooMany(perIp.retryAfterSeconds);
  }
  const burst = await consumeAttempt(
    deps.db,
    `site-lead|burst|${row.site.id}`,
    limits.perSiteBurst,
    now,
  );
  if (!burst.allowed) return tooMany(burst.retryAfterSeconds);
  const perSite = await consumeAttempt(
    deps.db,
    `site-lead|site|${row.site.id}`,
    limits.perSite,
    now,
  );
  if (!perSite.allowed) {
    console.warn(`Site ${row.site.id} reached its hourly lead ceiling (${limits.perSite.max})`);
    return tooMany(perSite.retryAfterSeconds);
  }

  let outcome: SiteLeadOutcome = "delivered";
  try {
    await sendToGhl(deps, row.location, lead);
  } catch (error) {
    outcome = "failed";
    // Logged without the visitor's details or GHL's text, which may echo them.
    const { name, status, operationId } = error as {
      name?: string;
      status?: number;
      operationId?: string;
    };
    console.error(
      `Site lead for site ${row.site.id} failed: ${name ?? "Error"}${operationId ? ` ${operationId}` : ""}${status ? ` ${status}` : ""}`,
    );
  }
  if (deps.provisioner) {
    // The visitor waits for the count, so it gets a short deadline; a slow token service or
    // database costs the count, never the visitor's answer.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        recordOutcome(deps.provisioner, row.location, row.site.id, outcome, now),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const late = new Error("took too long");
            late.name = "Timeout";
            reject(late);
          }, deps.countTimeoutMs ?? COUNT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.error(
        `Counting a lead for site ${row.site.id} failed: ${(error as Error)?.name ?? "Error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return outcome === "delivered" ? ACCEPTED : refuse(502, NOT_SENT);
}

/**
 * Counts the lead in the client's own database. There is no member on this path (a visitor sent
 * the form), so the token is minted for the client the site's registry row names and nothing
 * else, lives five minutes, and is used for one write.
 */
async function recordOutcome(
  provisioner: TenantProvisioner,
  client: typeof location.$inferSelect,
  siteId: string,
  outcome: SiteLeadOutcome,
  now: number,
): Promise<void> {
  // Not read-only: this path writes the count.
  const token = await provisioner.mintToken(client.tursoDbName, { ttl: "5m" });
  const tenant = openTenantDb(provisioner.url(client.tursoDbHostname), token);
  try {
    await countSiteLead(tenant, siteId, outcome, now);
  } finally {
    tenant.$client.close();
  }
}

/** Adds one lead to the site's count for the day (UTC) in the client's database. */
export async function countSiteLead(
  tenant: TenantDb,
  siteId: string,
  outcome: SiteLeadOutcome,
  now = Date.now(),
): Promise<void> {
  const column = outcome === "delivered" ? siteLeadDay.delivered : siteLeadDay.failed;
  const updatedAt = new Date(now);
  await tenant
    .insert(siteLeadDay)
    .values({
      siteId,
      day: updatedAt.toISOString().slice(0, 10),
      delivered: outcome === "delivered" ? 1 : 0,
      failed: outcome === "failed" ? 1 : 0,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [siteLeadDay.siteId, siteLeadDay.day],
      set: { [outcome]: sql`${column} + 1`, updatedAt },
    });
}

/** A visitor IP as kept in a counter key: HMAC-SHA256 under the server's key, shortened. */
export function hashVisitorIp(key: Uint8Array, ip: string): string {
  return createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

/**
 * Reads a request body as text, counting bytes as they arrive, and stops at `max` whatever the
 * Content-Length said (a chunked body has none). Null when the body is larger than `max`; the
 * rest of it is never read.
 */
export async function readLeadBody(
  body: ReadableStream<Uint8Array> | null,
  max = MAX_LEAD_BODY_BYTES,
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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

/** A contact as GHL returns it from an upsert; only the fields a form can fill. */
interface GhlContact {
  id?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  source?: string | null;
}

const blank = (value: string | null | undefined) => !value?.trim();

/** Whether what the visitor typed says the same as the contact's value, give or take format. */
function sameAs(key: string, typed: string, existing: string | null | undefined): boolean {
  if (blank(existing)) return false;
  if (key === "phone") {
    // The same number with or without its country code: "+1 555 010 0199" and "555-010-0199".
    const x = typed.replace(/\D/g, "");
    const y = (existing as string).replace(/\D/g, "");
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 7 && long.endsWith(short);
  }
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(typed) === norm(existing as string);
}

const NOTE_LABELS = {
  name: "Name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  companyName: "Company",
} as const;
const FILLABLE = Object.keys(NOTE_LABELS) as (keyof typeof NOTE_LABELS)[];

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

  // Anyone can type a customer's email into a form, so a form never changes a detail the CRM
  // already has (bead locus-ptq.18). The upsert sends only the one detail it matches on, so it
  // finds or creates the contact without changing anything else (GHL may still store that one
  // detail as the visitor typed it, e.g. its casing); then only the contact's blank fields are
  // filled, on that contact by id, and whatever else the visitor typed goes in the note.
  // No step is retried within a request, so each request adds at most one note. A visitor who
  // resends after a 502 whose note did land (a lost response) gets a second, identical note.
  // `tags` on upsert would replace the contact's tags, so they're added separately.
  const match = fields.email ? "email" : "phone";
  const upserted = await ghlRequest<{ new?: boolean; contact?: GhlContact }>(
    operation("contacts.upsert-contact"),
    session,
    { body: { [match]: fields[match] } },
    options,
  );
  const existing = upserted.contact ?? {};
  const contactId = existing.id;
  if (!contactId) throw new Error("GoHighLevel's upsert response had no contact id");
  const created = upserted.new === true;

  // A name is filled only when the contact has none at all, so it's never half one person's.
  const unnamed = blank(existing.name) && blank(existing.firstName) && blank(existing.lastName);
  const fill: Record<string, string> = {};
  const unused: (keyof typeof NOTE_LABELS)[] = [];
  for (const key of FILLABLE) {
    const typed = fields[key];
    if (!typed || key === match) continue;
    const isName = key === "name" || key === "firstName" || key === "lastName";
    if (isName ? unnamed : blank(existing[key])) fill[key] = typed;
    else if (!sameAs(key, typed, existing[key])) unused.push(key);
  }

  // Tags first: the lead is the CRM's from here on, whatever happens to the filling below.
  await ghlRequest(
    operation("contacts.add-tags"),
    session,
    { path: { contactId }, body: { tags: leadTags(form) } },
    options,
  );

  // Filling is best effort. GHL refuses a value it won't take (400/422, e.g. an email or phone
  // another contact already has when the sub-account keeps them unique); then the lead still
  // counts and what didn't fit goes in the note, so a resend can't fail the same way forever.
  const refused = (error: unknown) =>
    error instanceof GhlError && (error.status === 400 || error.status === 422);
  const { companyName, ...byId } = fill;
  if (created || blank(existing.source)) {
    byId.source = `Website form (${form})`;
  }
  if (Object.keys(byId).length > 0) {
    try {
      await ghlRequest(
        operation("contacts.update-contact"),
        session,
        { path: { contactId }, body: byId },
        options,
      );
    } catch (error) {
      if (!refused(error)) throw error;
      unused.push(...FILLABLE.filter((key) => key in byId));
    }
  }
  // Update Contact takes no company, so it goes through the upsert, which matches again rather
  // than naming the contact. Only for a contact this request just created: an existing contact
  // could share its email or phone with others (when the sub-account allows duplicates), and the
  // upsert might pick one of those. Otherwise the company goes in the note.
  if (companyName && created) {
    try {
      const again = await ghlRequest<{ contact?: GhlContact }>(
        operation("contacts.upsert-contact"),
        session,
        { body: { [match]: fields[match], companyName } },
        options,
      );
      if (again.contact?.id !== contactId) {
        console.warn("A site lead's company was set on a different contact than it created");
        unused.push("companyName");
      }
    } catch (error) {
      if (!refused(error)) throw error;
      unused.push("companyName");
    }
  } else if (companyName) {
    unused.push("companyName");
  }

  const lines: string[] = [];
  if (fields.message) lines.push(fields.message, "");
  if (unused.length > 0) {
    lines.push("Also on the form (kept here, not changed on the contact):");
    for (const key of unused) lines.push(`${NOTE_LABELS[key]}: ${fields[key]}`);
    lines.push("");
  }
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
