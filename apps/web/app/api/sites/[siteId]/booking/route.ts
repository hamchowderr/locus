import { bookSiteAppointment, readLeadBody } from "@locus/connect";
import { connectDeps, siteLeadIpKey } from "@/lib/connect";
import { NotConfigured } from "@/lib/locus";

/**
 * A published site's booking, forwarded server to server by the site's own `/api/locus` route.
 * As with forms, the client is read from the site's registry row, never from the request
 * (`bookSiteAppointment`), and only that client's own active calendars can be booked.
 */
export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return Response.json({ error: "Send the booking as JSON." }, { status: 415 });
  }
  const raw = await readLeadBody(request.body);
  if (raw === null) {
    return Response.json({ error: "That's too much to send." }, { status: 413 });
  }
  try {
    const result = await bookSiteAppointment(
      { ...connectDeps(), ipHashKey: siteLeadIpKey() },
      { siteId, raw, visitorIp: request.headers.get("x-locus-visitor-ip") },
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
    console.error(`Site booking route failed: ${(error as Error)?.name ?? "Error"}`);
    return Response.json({ error: "We couldn't book that just now." }, { status: 500 });
  }
}
