import { GhlError, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import {
  consumeSiteLimits,
  countWithDeadline,
  logGhlFailure,
  MAX_LEAD_BODY_BYTES,
  parseLead,
  publishedSite,
  type SiteGhl,
  type SiteLeadDeps,
  type SiteLeadOutcome,
  sendToGhl,
  siteGhl,
} from "./site-leads.ts";

// Booking on a published site, into one of the client's GHL calendars.
//
//   browser → the site's own /api/locus/booking/... (same origin) → Locus
//   /api/sites/<siteId>/booking/...
//
// Two public calls: the free times of a calendar, and booking one of them. As with forms, the
// site id is public and the client is read from the site's registry row, never from the
// request; no token reaches the site. The visitor names a calendar, but only one of the site's
// own client's active calendars is accepted: GHL's calendar lookup is checked against the
// sub-account the session is for, so another sub-account's calendar id gets nothing.
//
// A booking is also a lead: the contact goes through the same path as a form (found or created
// by email or phone, only blank fields filled, tagged, noted), then GHL books the time for that
// contact. GHL checks the time against the calendar's own rules (notice, hours, buffers), so a
// time that was just taken or was never offered is refused there too, not only here.

/** Limits for reading free times: generous, since a visitor clicks through days. */
export const SLOT_LIMITS = {
  perSite: { max: 2_000, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 120, windowMs: 60_000 },
  perIp: { max: 60, windowMs: 10 * 60_000 },
};

/** Limits for booking: tighter than reading, like a form. */
export const BOOKING_LIMITS = {
  perSite: { max: 200, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 20, windowMs: 60_000 },
  perIp: { max: 5, windowMs: 10 * 60_000 },
  minFillMs: 3_000,
};

/** The most days one request for free times may cover (GHL allows 31). */
export const MAX_SLOT_DAYS = 14;

const CALENDAR_ID = /^[A-Za-z0-9]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const NOT_CONNECTED = "Booking isn't connected on this site.";
const NO_CALENDAR = "That calendar isn't available for booking.";

export type SiteBookingResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 413 | 502; body: { error: string } }
  | { status: 429; body: { error: string }; retryAfterSeconds: number };

const refuse = (status: 400 | 404 | 409 | 413 | 502, error: string): SiteBookingResult => ({
  status,
  body: { error },
});
const tooMany = (retryAfterSeconds: number): SiteBookingResult => ({
  status: 429,
  body: { error: "Too many tries from here. Please try again later." },
  retryAfterSeconds,
});

function operation(id: string) {
  const op = operationById(id);
  if (!op) throw new Error(`The skill catalog is missing ${id}`);
  return op;
}

/** A timezone the runtime knows, or null. */
export function validTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

interface GhlCalendar {
  id?: string;
  locationId?: string;
  name?: string;
  isActive?: boolean;
  slotDuration?: number;
  slotDurationUnit?: string;
}

/**
 * The calendar, only when it is one of this client's and active. GHL is asked with the
 * client's own session and its answer is checked against that sub-account too.
 */
async function bookableCalendar(ghl: SiteGhl, calendarId: string): Promise<GhlCalendar | null> {
  try {
    const found = await ghlRequest<{ calendar?: GhlCalendar }>(
      operation("calendars.get-calendar"),
      ghl.session,
      { path: { calendarId } },
      ghl.options,
    );
    const calendar = found.calendar;
    if (!calendar || calendar.locationId !== ghl.session.locationId) return null;
    if (calendar.isActive === false) return null;
    return calendar;
  } catch (error) {
    if (error instanceof GhlError && error.status >= 400 && error.status < 500) return null;
    throw error;
  }
}

/** Free times by day (`YYYY-MM-DD` → ISO times), as GHL gives them, keeping only real days. */
async function freeSlots(
  ghl: SiteGhl,
  calendarId: string,
  startMs: number,
  endMs: number,
  timezone: string,
): Promise<{ date: string; slots: string[] }[]> {
  const found = await ghlRequest<Record<string, unknown>>(
    operation("calendars.get-slots"),
    ghl.session,
    { path: { calendarId }, query: { startDate: startMs, endDate: endMs, timezone } },
    ghl.options,
  );
  const days: { date: string; slots: string[] }[] = [];
  for (const [date, value] of Object.entries(found ?? {})) {
    if (!DAY.test(date)) continue; // GHL adds e.g. `traceId` beside the days.
    const slots = (value as { slots?: unknown })?.slots;
    if (!Array.isArray(slots)) continue;
    const times = slots.filter(
      (t): t is string => typeof t === "string" && t.length <= 40 && !Number.isNaN(Date.parse(t)),
    );
    days.push({ date, slots: times });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export interface SlotQuery {
  siteId: string;
  /** From the visitor's query string: all untrusted. */
  calendarId: string | null;
  start: string | null;
  days: string | null;
  timezone: string | null;
  visitorIp: string | null;
}

/** The free times of one of the site's client's calendars, for a few days from `start`. */
export async function siteSlots(deps: SiteLeadDeps, query: SlotQuery): Promise<SiteBookingResult> {
  const calendarId = query.calendarId ?? "";
  if (!CALENDAR_ID.test(calendarId)) return refuse(400, NO_CALENDAR);
  const timezone = validTimezone(query.timezone ?? "UTC");
  if (!timezone) return refuse(400, "That timezone isn't one we know.");
  const now = deps.now?.() ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const start = query.start ?? today;
  if (!DAY.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) {
    return refuse(400, "That date isn't one we can read.");
  }
  const days = query.days === null ? 7 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_SLOT_DAYS) {
    return refuse(400, `Ask for 1 to ${MAX_SLOT_DAYS} days at a time.`);
  }
  // From the start of that day (a day early, so no timezone loses its morning), never before
  // yesterday and never further ahead than a year.
  const startMs = Math.max(Date.parse(`${start}T00:00:00Z`) - DAY_MS, now - DAY_MS);
  if (startMs > now + 366 * DAY_MS) return refuse(400, "That date is too far ahead.");
  const endMs = startMs + (days + 1) * DAY_MS - 1;

  const row = await publishedSite(deps.db, query.siteId);
  if (!row) return refuse(404, NOT_CONNECTED);
  const limited = await consumeSiteLimits(
    deps,
    row.site.id,
    query.visitorIp,
    SLOT_LIMITS,
    now,
    "slots",
  );
  if (limited !== null) return tooMany(limited);

  try {
    const ghl = await siteGhl(deps, row.location);
    const calendar = await bookableCalendar(ghl, calendarId);
    if (!calendar) return refuse(404, NO_CALENDAR);
    const all = await freeSlots(ghl, calendarId, startMs, endMs, timezone);
    // Only the days asked for, in the visitor's timezone.
    const last = new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return {
      status: 200,
      body: {
        calendar: { name: calendar.name ?? "" },
        timezone,
        days: all.filter((d) => d.date >= start && d.date <= last),
      },
    };
  } catch (error) {
    logGhlFailure(`Free times for site ${row.site.id}`, error);
    return refuse(502, "We couldn't load the times just now. Please try again.");
  }
}

export interface BookingInput {
  siteId: string;
  /** The request body as text, at most `MAX_LEAD_BODY_BYTES`. */
  raw: string;
  visitorIp: string | null;
}

/**
 * Books a free time on one of the site's client's calendars for the visitor: the contact goes
 * in as a lead (form `booking` unless the site names one), then GHL books the appointment.
 */
export async function bookSiteAppointment(
  deps: SiteLeadDeps,
  input: BookingInput,
): Promise<SiteBookingResult> {
  if (Buffer.byteLength(input.raw) > MAX_LEAD_BODY_BYTES) {
    return refuse(413, "That's too much to send.");
  }
  let body: unknown;
  try {
    body = JSON.parse(input.raw);
  } catch {
    return refuse(400, "That booking didn't send anything we could read.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "That booking didn't send anything we could read.");
  }
  const { calendarId, startTime, timezone, ...rest } = body as Record<string, unknown>;
  if (typeof calendarId !== "string" || !CALENDAR_ID.test(calendarId)) {
    return refuse(400, NO_CALENDAR);
  }
  const start = typeof startTime === "string" && startTime.length <= 40 ? startTime : "";
  const startMs = Date.parse(start);
  if (!start || Number.isNaN(startMs) || !/T\d{2}:\d{2}/.test(start)) {
    return refuse(400, "Please choose a time.");
  }
  const zone = timezone === undefined ? "UTC" : validTimezone(timezone);
  if (!zone) return refuse(400, "That timezone isn't one we know.");
  const parsed = parseLead({ form: "booking", ...rest });
  if ("error" in parsed) return refuse(400, parsed.error);
  const { lead, honeypot, elapsedMs } = parsed;

  const row = await publishedSite(deps.db, input.siteId);
  if (!row) return refuse(404, NOT_CONNECTED);
  const now = deps.now?.() ?? Date.now();
  if (startMs <= now) return refuse(409, "That time has passed. Please choose another.");
  // A bot: nothing is booked, and it learns nothing.
  if (honeypot || elapsedMs === null || elapsedMs < BOOKING_LIMITS.minFillMs) {
    return { status: 200, body: { ok: true, startTime: start } };
  }
  const limited = await consumeSiteLimits(
    deps,
    row.site.id,
    input.visitorIp,
    BOOKING_LIMITS,
    now,
    "booking",
  );
  if (limited !== null) return tooMany(limited);

  let ghl: SiteGhl;
  try {
    ghl = await siteGhl(deps, row.location);
    const calendar = await bookableCalendar(ghl, calendarId);
    if (!calendar) return refuse(404, NO_CALENDAR);
    // The time must be one GHL offers now: a clear answer when it was just taken.
    const day = new Date(startMs).toISOString().slice(0, 10);
    const around = Date.parse(`${day}T00:00:00Z`) - DAY_MS;
    const offered = (await freeSlots(ghl, calendarId, around, around + 3 * DAY_MS - 1, zone))
      .flatMap((d) => d.slots)
      .some((slot) => Date.parse(slot) === startMs);
    if (!offered) return refuse(409, "That time was just taken. Please choose another.");
  } catch (error) {
    logGhlFailure(`Booking check for site ${row.site.id}`, error);
    return refuse(502, "We couldn't book that just now. Please try again.");
  }

  let outcome: SiteLeadOutcome = "delivered";
  let refused: SiteBookingResult | null = null;
  try {
    const contactId = await sendToGhl(ghl, lead, [`Booked: ${start} (${zone})`]);
    await bookFor(ghl, { calendarId, contactId, startTime: start });
  } catch (error) {
    outcome = "failed";
    logGhlFailure(`Booking for site ${row.site.id}`, error);
    // GHL's own slot rules said no (taken in the meantime, too soon, outside hours).
    if (error instanceof GhlError && (error.status === 400 || error.status === 422)) {
      refused = refuse(409, "That time can't be booked any more. Please choose another.");
    }
  }
  await countWithDeadline(deps, row, outcome, now);
  if (outcome === "delivered") return { status: 200, body: { ok: true, startTime: start } };
  return refused ?? refuse(502, "We couldn't book that just now. Please try again.");
}

/**
 * The appointment itself. GHL's own slot rules apply (no `ignoreFreeSlotValidation`), and the
 * calendar's own event title and status settings are left to decide the rest.
 */
async function bookFor(
  ghl: SiteGhl,
  booking: { calendarId: string; contactId: string; startTime: string },
): Promise<void> {
  await ghlRequest(
    operation("calendars.create-appointment"),
    ghl.session,
    { body: booking },
    ghl.options,
  );
}
