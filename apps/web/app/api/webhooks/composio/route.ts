import { emailFromEnv } from "@locus/auth";
import { ComposioWebhookRejected, readComposioWebhook } from "@locus/harness";
import { type ExpiredAppDeps, tellExpiredApp } from "@/lib/app-expired";
import { appConnectionsFromEnv } from "@/lib/apps";
import { baseUrl } from "@/lib/connect";
import { locus } from "@/lib/locus";

/**
 * Composio's webhooks, signed with the project's subscription secret
 * (`COMPOSIO_WEBHOOK_SECRET`). The signature is checked against the raw body before anything is
 * read; an unsigned or wrongly signed delivery changes nothing. Only an expired sign-in is acted
 * on: the client's agency owners and admins are emailed.
 */
export async function POST(request: Request) {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!apiKey || !secret) return Response.json({ error: "not configured" }, { status: 503 });
  // Built before reading the delivery: a deployment that can't send email says so, rather than
  // failing every delivery Composio then retries.
  let deps: ExpiredAppDeps;
  try {
    deps = expiredAppDeps();
  } catch (error) {
    console.error("Composio webhook: Locus or its email isn't set up", error);
    return Response.json({ error: "not configured" }, { status: 503 });
  }
  const body = await request.text();
  let event: Awaited<ReturnType<typeof readComposioWebhook>>;
  try {
    event = await readComposioWebhook({ apiKey, secret }, body, request.headers);
  } catch (error) {
    if (error instanceof ComposioWebhookRejected) {
      console.warn(`Composio webhook refused: ${error.message}`);
      return Response.json({ error: "bad signature" }, { status: 401 });
    }
    throw error;
  }
  if (event.type === "unreadable") {
    // Signed by Composio, so not retried: a retry would read the same.
    console.error(`Composio webhook: couldn't read a signed delivery: ${event.reason}`);
    return Response.json({ outcome: "unreadable" });
  }
  if (event.type !== "expired") return Response.json({ outcome: "ignored" });
  return Response.json({ outcome: await tellExpiredApp(deps, event) });
}

function expiredAppDeps(): ExpiredAppDeps {
  const connections = appConnectionsFromEnv();
  return {
    db: locus().db,
    sendEmail: emailFromEnv(),
    baseUrl: baseUrl(),
    ...(connections
      ? {
          appName: async (toolkit) =>
            (await connections.catalog()).find((app) => app.toolkit === toolkit)?.name,
          reconnected: async (clientId, toolkit) =>
            (await connections.list(clientId)).some(
              (app) => app.toolkit === toolkit && app.connected,
            ),
        }
      : {}),
  };
}
