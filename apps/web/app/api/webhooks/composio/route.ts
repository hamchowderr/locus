import { emailFromEnv } from "@locus/auth";
import { ComposioWebhookRejected, readComposioWebhook } from "@locus/harness";
import { tellExpiredApp } from "@/lib/app-expired";
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
  const body = await request.text();
  let event: Awaited<ReturnType<typeof readComposioWebhook>>;
  try {
    event = await readComposioWebhook({ apiKey, secret }, body, request.headers);
  } catch (error) {
    if (error instanceof ComposioWebhookRejected) {
      return Response.json({ error: "bad signature" }, { status: 401 });
    }
    throw error;
  }
  if (event.type !== "expired") return Response.json({ outcome: "ignored" });
  const connections = appConnectionsFromEnv();
  const outcome = await tellExpiredApp(
    {
      db: locus().db,
      sendEmail: emailFromEnv(),
      baseUrl: baseUrl(),
      ...(connections
        ? {
            appName: async (toolkit: string) =>
              (await connections.catalog()).find((app) => app.toolkit === toolkit)?.name,
          }
        : {}),
    },
    event,
  );
  return Response.json({ outcome });
}
