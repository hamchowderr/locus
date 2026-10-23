/**
 * Composio's webhooks to Locus. Composio signs each delivery with the project's subscription
 * secret; the SDK checks the signature and its age before anything in the body is read.
 */

import { Composio, WebhookEventTypes } from "@composio/core";
import { clientOfAppUser } from "./composio.ts";

/** A delivery Locus acts on; anything else Composio sends is `ignored`. */
export type ComposioWebhookEvent =
  | { type: "expired"; clientId: string; toolkit: string }
  | { type: "ignored" };

/** The signature didn't match, was missing, or the delivery is too old. Nothing was read. */
export class ComposioWebhookRejected extends Error {
  override name = "ComposioWebhookRejected";
}

/**
 * Checks a delivery's signature and reads it. A client's sign-in that expired names the client
 * through its Composio user (`appUserId`); one that isn't a Locus client's is ignored.
 */
export async function readComposioWebhook(
  { apiKey, secret }: { apiKey: string; secret: string },
  body: string,
  headers: Headers,
): Promise<ComposioWebhookEvent> {
  const composio = new Composio({ apiKey, allowTracking: false, disableVersionCheck: true });
  let raw: unknown;
  try {
    ({ rawPayload: raw } = await composio.triggers.verifyWebhook({
      payload: body,
      signature: headers.get("webhook-signature") ?? "",
      id: headers.get("webhook-id") ?? "",
      timestamp: headers.get("webhook-timestamp") ?? "",
      secret,
    }));
  } catch (error) {
    throw new ComposioWebhookRejected(error instanceof Error ? error.message : String(error));
  }
  const event = raw as {
    type?: unknown;
    data?: { user_id?: unknown; toolkit?: { slug?: unknown } };
  };
  if (event.type !== WebhookEventTypes.CONNECTION_EXPIRED) return { type: "ignored" };
  const user = event.data?.user_id;
  const toolkit = event.data?.toolkit?.slug;
  const clientId = typeof user === "string" ? clientOfAppUser(user) : undefined;
  if (!clientId || typeof toolkit !== "string" || toolkit === "") return { type: "ignored" };
  return { type: "expired", clientId, toolkit: toolkit.toLowerCase() };
}
