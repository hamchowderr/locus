import { siteSlots } from "@locus/connect";
import { connectDeps, siteLeadIpKey } from "@/lib/connect";
import { NotConfigured } from "@/lib/locus";

/**
 * Free times on one of a published site's client's calendars, asked for server to server by the
 * site's own `/api/locus` route. Everything in the query is checked in `siteSlots`; the client
 * comes from the site's registry row.
 */
export async function GET(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const query = new URL(request.url).searchParams;
  try {
    const result = await siteSlots(
      { ...connectDeps(), ipHashKey: siteLeadIpKey() },
      {
        siteId,
        calendarId: query.get("calendarId"),
        start: query.get("start"),
        days: query.get("days"),
        timezone: query.get("timezone"),
        visitorIp: request.headers.get("x-locus-visitor-ip"),
      },
    );
    return Response.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        ...(result.status === 429 ? { "retry-after": String(result.retryAfterSeconds) } : {}),
      },
    });
  } catch (error) {
    if (error instanceof NotConfigured) {
      return Response.json({ error: "Booking isn't connected on this site." }, { status: 503 });
    }
    console.error(`Site slots route failed: ${(error as Error)?.name ?? "Error"}`);
    return Response.json({ error: "We couldn't load the times just now." }, { status: 500 });
  }
}
