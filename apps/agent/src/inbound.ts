import type { InboundMessage } from "@locus/agent-api";
import { verifyGhlSignature } from "@locus/connect";

// New messages from GHL: the web app receives the Locus app's webhooks and passes `InboundMessage`
// on here, unchanged, with GHL's signature. That signature is the only credential: no cookie is
// read, and nothing is done for a body GHL didn't sign. A message from a contact starts a
// drafted reply (`@locus/agent-api`'s `inbox.ts`) for each client the location belongs to that
// has drafting on. Nothing of the message is kept: only its ids reach the draft's brief.

export const INBOUND_PATH = "/api/agent/inbound";

/** The largest webhook body read; GHL's are a few KB. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Channels a reply can go back on. Calls and voicemails (`CALL`) have nothing to answer in
 * writing; GHL's send has no type for Google Business (`GMB`).
 */
const DRAFTED = new Set(["SMS", "Email", "FB", "IG", "WhatsApp", "Live Chat", "Live_Chat"]);

export type InboundOutcome = "ignored" | "drafting" | "off";

export interface InboundDeps {
  /** GHL's webhook public key; null leaves the route answering 404. */
  publicKey: string | null;
  /**
   * Drafts a reply for the message in every client the GHL location belongs to that has
   * drafting on, after the staff check for the member drafts run as. Resolves to whether any did.
   */
  draft: (ghlLocationId: string, message: InboundMessage) => Promise<boolean>;
  logError: (message: string, error?: unknown) => void;
}

/** The fields Locus reads from GHL's `InboundMessage` webhook. */
interface InboundEvent {
  type?: unknown;
  appId?: unknown;
  locationId?: unknown;
  conversationId?: unknown;
  contactId?: unknown;
  messageId?: unknown;
  messageType?: unknown;
  direction?: unknown;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

export function inboundMessages(deps: InboundDeps & { appId: string }) {
  return async (request: Request): Promise<Response> => {
    if (!deps.publicKey || request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const raw = await readText(request, MAX_BODY_BYTES);
    if (raw === null) return Response.json({ error: "too large" }, { status: 413 });
    if (!verifyGhlSignature(raw, request.headers.get("x-ghl-signature"), deps.publicKey)) {
      return Response.json({ error: "bad signature" }, { status: 401 });
    }
    let event: InboundEvent;
    try {
      event = JSON.parse(raw) as InboundEvent;
    } catch {
      return Response.json({ error: "bad body" }, { status: 400 });
    }
    const outcome = await handle(deps, event);
    return Response.json({ outcome });
  };
}

async function handle(
  deps: InboundDeps & { appId: string },
  event: InboundEvent,
): Promise<InboundOutcome> {
  if (event.type !== "InboundMessage" || event.direction !== "inbound") return "ignored";
  // GHL signs every app's webhooks with one key: one sent for another app is not ours.
  if (event.appId !== undefined && event.appId !== deps.appId) return "ignored";
  const ghlLocationId = text(event.locationId);
  const conversationId = text(event.conversationId);
  const contactId = text(event.contactId);
  const channel = text(event.messageType);
  if (!ghlLocationId || !conversationId || !contactId || !channel) return "ignored";
  if (!DRAFTED.has(channel)) return "ignored";
  const messageId = text(event.messageId);
  try {
    const drafted = await deps.draft(ghlLocationId, {
      conversationId,
      contactId,
      channel,
      ...(messageId ? { messageId } : {}),
    });
    return drafted ? "drafting" : "off";
  } catch (error) {
    // GHL retries a failed delivery; a draft that failed to start is not worth a second one.
    deps.logError(`Drafting a reply failed for location ${ghlLocationId}`, error);
    return "off";
  }
}

async function readText(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
