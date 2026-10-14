import { MAX_LEAD_BODY_BYTES, submitSiteLead } from "@locus/connect";
import { connectDeps } from "@/lib/connect";
import { NotConfigured } from "@/lib/locus";

/**
 * A published site's lead form, forwarded server to server by the site's own `/api/lead` route.
 * The site id in the path is public; the client is read from the site's registry row, never
 * from the request (`submitSiteLead`). No CORS headers on purpose: a browser on another origin
 * can't send the JSON this route requires, so only servers (the site's route) reach it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return Response.json({ error: "Send the form as JSON." }, { status: 415 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_LEAD_BODY_BYTES) {
    return Response.json({ error: "That's too much to send." }, { status: 413 });
  }
  const raw = await request.text();
  try {
    const result = await submitSiteLead(connectDeps(), {
      siteId,
      raw,
      // Set by the site's route from its host's own forwarding header. A hint for the per-IP
      // limit only; the per-site limit holds whatever it says.
      visitorIp: request.headers.get("x-locus-visitor-ip"),
    });
    return Response.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        ...(result.status === 429 ? { "retry-after": String(result.retryAfterSeconds) } : {}),
      },
    });
  } catch (error) {
    if (error instanceof NotConfigured) {
      return Response.json({ error: "This form isn't connected." }, { status: 503 });
    }
    console.error(`Site lead route failed: ${(error as Error)?.name ?? "Error"}`);
    return Response.json({ error: "We couldn't send that just now." }, { status: 500 });
  }
}
