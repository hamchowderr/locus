import { type AuthorizedClient, assertAuthorizedClient } from "@locus/auth";
import { type GhlRateLimiter, ghlRequest, sharedRateLimiter } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { type ConnectDeps, clientGhlSession } from "./agency.ts";

// The client's GHL inbox, as the chat's Inbox tab shows it: the latest conversations, read
// live from GHL for this request only and never stored (`.claude/rules/tenancy.md`). The
// session is the client's own, minted after the staff check, so nothing here names a location.

/** One conversation, as the Inbox lists it. */
export interface InboxConversation {
  id: string;
  contactId: string;
  /** The contact's name, or their email or phone when GHL has no name. */
  contact: string;
  /** The channel of the latest message, in plain words ("SMS", "Live chat"). */
  channel: string;
  /** The latest message, cut short. Text only: never rendered as HTML. */
  preview: string;
  /** When the latest message came or went, when GHL says. */
  at: Date | null;
  unread: number;
}

/** Conversations listed: GHL's own default page. */
export const INBOX_PAGE = 20;

/** The longest preview kept of a message. */
const PREVIEW_CHARS = 140;

const GHL_ID = /^[A-Za-z0-9]{1,64}$/;

/** GHL's message types, in the words a person uses. Anything else reads as "Message". */
const CHANNELS: Record<string, string> = {
  TYPE_SMS: "SMS",
  TYPE_CUSTOM_SMS: "SMS",
  TYPE_CUSTOM_PROVIDER_SMS: "SMS",
  TYPE_CAMPAIGN_SMS: "SMS",
  TYPE_EMAIL: "Email",
  TYPE_CUSTOM_EMAIL: "Email",
  TYPE_CUSTOM_PROVIDER_EMAIL: "Email",
  TYPE_CAMPAIGN_EMAIL: "Email",
  TYPE_CALL: "Call",
  TYPE_IVR_CALL: "Call",
  TYPE_CUSTOM_CALL: "Call",
  TYPE_CAMPAIGN_CALL: "Call",
  TYPE_CAMPAIGN_VOICEMAIL: "Voicemail",
  TYPE_LIVE_CHAT: "Live chat",
  TYPE_LIVE_CHAT_INFO_MESSAGE: "Live chat",
  TYPE_WEBCHAT: "Live chat",
  TYPE_FACEBOOK: "Facebook",
  TYPE_CAMPAIGN_FACEBOOK: "Facebook",
  TYPE_FACEBOOK_COMMENT: "Facebook",
  TYPE_INSTAGRAM: "Instagram",
  TYPE_INSTAGRAM_COMMENT: "Instagram",
  TYPE_WHATSAPP: "WhatsApp",
  TYPE_GMB: "Google",
  TYPE_CAMPAIGN_GMB: "Google",
  TYPE_REVIEW: "Review",
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** GHL gives the latest message's time in milliseconds, or as a date string. */
function dateOf(value: unknown): Date | null {
  const d =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function conversationOf(raw: unknown): InboxConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = text(c.id);
  const contactId = text(c.contactId);
  if (!GHL_ID.test(id) || !GHL_ID.test(contactId)) return null;
  const unread = typeof c.unreadCount === "number" && c.unreadCount > 0 ? c.unreadCount : 0;
  return {
    id,
    contactId,
    contact:
      text(c.fullName) ||
      text(c.contactName) ||
      text(c.email) ||
      text(c.phone) ||
      "Unknown contact",
    channel: CHANNELS[text(c.lastMessageType)] ?? "Message",
    preview: preview(text(c.lastMessageBody)),
    at: dateOf(c.lastMessageDate),
    unread: Math.floor(unread),
  };
}

/**
 * The client's latest conversations, newest first, read from GHL now. Takes the result of the
 * staff check (`authorizeClient` or `resolveActiveClient`), like `clientGhlSession`.
 */
export async function listInbox(
  deps: ConnectDeps & { rateLimiter?: GhlRateLimiter },
  client: AuthorizedClient,
): Promise<InboxConversation[]> {
  assertAuthorizedClient(client);
  const op = operationById("conversations.search-conversation");
  if (!op) throw new Error("The skill catalog is missing conversations.search-conversation");
  const session = await clientGhlSession(deps, client);
  const found = await ghlRequest<{ conversations?: unknown[] }>(
    op,
    session,
    {
      query: {
        sortBy: "last_message_date",
        sort: "desc",
        status: "all",
        limit: String(INBOX_PAGE),
      },
    },
    { ...deps.http, rateLimiter: deps.rateLimiter ?? sharedRateLimiter },
  );
  const raw = Array.isArray(found.conversations) ? found.conversations : [];
  return raw
    .slice(0, INBOX_PAGE)
    .map(conversationOf)
    .filter((c): c is InboxConversation => c !== null);
}
