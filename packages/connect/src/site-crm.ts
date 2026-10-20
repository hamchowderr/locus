import { type GhlRequestOptions, type GhlSession, ghlRequest, sharedRateLimiter } from "@locus/ghl";
import { operationById } from "@locus/skills";

// What the site builder may read from the client's sub-account to wire a site into it:
// calendars to book on. Read-only, through the session's own client (the host passes a session
// minted after the staff check), never cached. Names and descriptions are the client's own
// text, so the builder screens them as data before the model sees them.

/** A calendar the builder can put on a site. */
export interface CrmCalendar {
  id: string;
  name: string;
  /** GHL's calendar kind: event, round_robin, class_booking, service_booking, … */
  type: string;
  /** GHL's own booking page for it, for an embedded calendar. */
  embedUrl: string;
}

/** The sub-account reads the builder uses. */
export interface SiteCrm {
  calendars(): Promise<CrmCalendar[]>;
}

/** GHL's hosted booking widget for one calendar (its "permanent link"). */
export const calendarEmbedUrl = (calendarId: string) =>
  `https://api.leadconnectorhq.com/widget/booking/${encodeURIComponent(calendarId)}`;

/** The client's active calendars, in GHL's order. */
export async function listCalendars(
  session: GhlSession,
  options: GhlRequestOptions = {},
): Promise<CrmCalendar[]> {
  const op = operationById("calendars.get-calendars");
  if (!op) throw new Error("The skill catalog is missing calendars.get-calendars");
  const found = await ghlRequest<{ calendars?: Record<string, unknown>[] }>(
    op,
    session,
    { query: { showDrafted: false } },
    options,
  );
  const calendars: CrmCalendar[] = [];
  for (const c of found.calendars ?? []) {
    const id = typeof c.id === "string" ? c.id : "";
    if (!/^[A-Za-z0-9]{1,64}$/.test(id) || c.isActive === false) continue;
    calendars.push({
      id,
      name: typeof c.name === "string" ? c.name.slice(0, 120) : "",
      type: typeof c.calendarType === "string" ? c.calendarType.slice(0, 40) : "",
      embedUrl: calendarEmbedUrl(id),
    });
  }
  return calendars;
}

/**
 * The builder's reads for one client. `open` mints the client's GHL session for each read (the
 * host's `clientGhlSession`, after the staff check) and says how to reach GHL; nothing is kept
 * between reads.
 */
export function siteCrm(
  open: () => Promise<{ session: GhlSession; http?: Pick<GhlRequestOptions, "fetch" | "baseUrl"> }>,
): SiteCrm {
  const opened = async () => {
    const { session, http } = await open();
    return { session, options: { ...http, rateLimiter: sharedRateLimiter } };
  };
  return {
    calendars: async () => {
      const { session, options } = await opened();
      return listCalendars(session, options);
    },
  };
}
