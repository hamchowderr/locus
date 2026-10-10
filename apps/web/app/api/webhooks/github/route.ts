import { type GithubWebhook, handleGithubWebhook, verifyGithubSignature } from "@locus/connect";
import { locus } from "@/lib/locus";

/**
 * The GitHub App's webhooks. The signature is checked against the raw body before anything
 * is parsed; an unsigned or wrongly signed delivery changes nothing.
 */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "not configured" }, { status: 503 });
  const raw = await request.text();
  if (!verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: GithubWebhook;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  const outcome = await handleGithubWebhook(
    { db: locus().db },
    request.headers.get("x-github-event"),
    payload,
  );
  return Response.json({ outcome });
}
