import { handleGhlWebhook, verifyGhlSignature } from "@locus/connect";
import { connectDeps } from "@/lib/connect";
import { NotConfigured } from "@/lib/locus";

/**
 * GHL's app webhooks (install/uninstall). The signature is checked against the raw body before
 * anything is parsed; an unsigned or wrongly signed request changes nothing.
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
