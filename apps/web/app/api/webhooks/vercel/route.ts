import { handleVercelWebhook, type VercelWebhook, verifyVercelSignature } from "@locus/connect";
import { vercelDeps } from "@/lib/hosts";
import { NotConfigured } from "@/lib/locus";

/**
 * The Locus Vercel Integration's webhooks, signed with its client secret. The signature is
 * checked against the raw body before anything is parsed; an unsigned or wrongly signed
 * delivery changes nothing.
 */
export async function POST(request: Request) {
  let deps: ReturnType<typeof vercelDeps>;
  try {
    deps = vercelDeps();
  } catch (error) {
    if (error instanceof NotConfigured) {
      return Response.json({ error: "not configured" }, { status: 503 });
    }
    throw error;
  }
  const raw = await request.text();
  if (
    !verifyVercelSignature(raw, request.headers.get("x-vercel-signature"), deps.vercel.clientSecret)
  ) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let event: VercelWebhook;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  return Response.json({ outcome: await handleVercelWebhook(deps, event) });
}
