import { handleGhlWebhook, verifyGhlSignature } from "@locus/connect";
import { connectDeps } from "@/lib/connect";
import { NotConfigured } from "@/lib/locus";

/**
 * GHL's app webhooks. The signature is checked against the raw body before anything is parsed;
 * an unsigned or wrongly signed request changes nothing. Install and uninstall are handled here;
 * a new message from a contact goes on to the agent server, unchanged and with GHL's signature,
 * which checks it again and drafts a reply where that is on.
 */
export async function POST(request: Request) {
  const publicKey = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) return Response.json({ error: "not configured" }, { status: 503 });
  const raw = await request.text();
  if (!verifyGhlSignature(raw, request.headers.get("x-ghl-signature"), publicKey)) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  if ((event as { type?: unknown } | null)?.type === "InboundMessage") {
    return forwardToAgent(raw, request.headers.get("x-ghl-signature") ?? "");
  }
  try {
    const outcome = await handleGhlWebhook(
      connectDeps(),
      event as Parameters<typeof handleGhlWebhook>[1],
    );
    return Response.json({ outcome });
  } catch (error) {
    if (error instanceof NotConfigured) {
      return Response.json({ error: "not configured" }, { status: 503 });
    }
    throw error;
  }
}

/** Where the agent server takes new messages (`apps/agent/src/inbound.ts`). */
const AGENT_INBOUND_PATH = "/api/agent/inbound";

async function forwardToAgent(raw: string, signature: string): Promise<Response> {
  const agent = process.env.LOCUS_AGENT_URL?.replace(/\/+$/, "");
  // No agent server here: nothing drafts replies, and GHL needn't retry.
  if (!agent) return Response.json({ outcome: "ignored" });
  const res = await fetch(`${agent}${AGENT_INBOUND_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ghl-signature": signature },
    body: raw,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) return Response.json({ error: "agent unreachable" }, { status: 502 });
  return Response.json(await res.json().catch(() => ({})), { status: res.status });
}
