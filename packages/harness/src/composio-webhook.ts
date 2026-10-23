/**
 * Composio's webhooks to Locus. Composio signs each delivery with the project's subscription
 * secret; the SDK checks the signature and its age before anything in the body is read.
 */

import {
  Composio,
  ComposioWebhookSignatureVerificationError,
  WebhookEventTypes,
} from "@composio/core";
import { clientOfAppUser } from "./composio.ts";

/**
 * A delivery Locus acts on, with Composio's id for it (the same on every retry); anything
 * else Composio sends is `ignored`, and a signed body the SDK can't read is `unreadable`.
 */
export type ComposioWebhookEvent =
  | { type: "expired"; deliveryId: string; clientId: string; account: string; toolkit: string }
  | { type: "ignored" }
  | { type: "unreadable"; reason: string };

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
  const deliveryId = headers.get("webhook-id") ?? "";
  const timestamp = headers.get("webhook-timestamp") ?? "";
  // The SDK reads the timestamp before the signature; one that isn't a number is refused here,
  // so every error it raises past this point comes after the signature matched.
  if (!/^\d+$/.test(timestamp)) throw new ComposioWebhookRejected("no webhook timestamp");
  const composio = new Composio({ apiKey, allowTracking: false, disableVersionCheck: true });
  let raw: unknown;
  try {
    ({ rawPayload: raw } = await composio.triggers.verifyWebhook({
      payload: body,
      signature: headers.get("webhook-signature") ?? "",
      id: deliveryId,
      timestamp,
      secret,
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ComposioWebhookSignatureVerificationError) {
      throw new ComposioWebhookRejected(reason);
    }
    return { type: "unreadable", reason };
  }
  const event = raw as {
    type?: unknown;
    data?: { id?: unknown; user_id?: unknown; toolkit?: { slug?: unknown } };
  };
  if (event.type !== WebhookEventTypes.CONNECTION_EXPIRED) return { type: "ignored" };
  const user = event.data?.user_id;
  const account = event.data?.id;
  const toolkit = event.data?.toolkit?.slug;
  if (typeof user !== "string" || typeof account !== "string" || typeof toolkit !== "string") {
    // Said so rather than ignored: were Composio to drop a field, nobody would be told again.
    return { type: "unreadable", reason: "an expired sign-in without its user, account or app" };
  }
  const clientId = clientOfAppUser(user);
  if (!clientId || toolkit === "") return { type: "ignored" };
  return { type: "expired", deliveryId, clientId, account, toolkit: toolkit.toLowerCase() };
}
