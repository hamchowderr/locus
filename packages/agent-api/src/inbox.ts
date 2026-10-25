/**
 * Drafted replies to a client's new GHL messages: a contact writes in, and the Conversations
 * agent drafts an answer in a work thread of its own, which waits for a person's yes before it
 * sends (every message to a contact does, `needsApproval`).
 *
 * The thread's brief carries ids only, never the message: the agent reads the conversation from
 * GHL itself, so what the contact wrote reaches it as data and taints the run, and nothing of
 * it is stored here. The thread starts untrusted (the host taints the run that starts it).
 *
 * One open draft per conversation: while a thread for it is working, queued or waiting on the
 * person, another message in the same conversation starts nothing (the agent reads the latest
 * when it runs, and the person sees the conversation in GHL). Once it has ended, the next
 * message starts a fresh one.
 */

import type { RequestContext } from "@mastra/core/request-context";
import type { MastraStorage } from "@mastra/core/storage";
import { siteOf, workThreadOf } from "./mastra/lib/work-thread-info.ts";
import type { ThreadAgent, WorkThreads } from "./mastra/lib/work-threads.ts";

/** The thread-metadata key naming the GHL conversation a draft thread answers. */
export const INBOX_CONVERSATION_KEY = "inboxConversation";

/** A new message from a contact, as GHL's `InboundMessage` webhook names it. Ids only. */
export interface InboundMessage {
  conversationId: string;
  contactId: string;
  messageId?: string | undefined;
  /** GHL's `messageType`, e.g. `SMS`, `Email`, `FB`, `IG`, `Live Chat`, `WhatsApp`. */
  channel: string;
}

/** GHL ids are short tokens; anything else is refused rather than written into a brief. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Channel names as GHL sends them (`Live Chat` has a space). */
const CHANNEL = /^[A-Za-z0-9 _-]{1,32}$/;

export function isInboundMessage(value: InboundMessage): boolean {
  return (
    ID.test(value.conversationId) &&
    ID.test(value.contactId) &&
    (value.messageId === undefined || ID.test(value.messageId)) &&
    CHANNEL.test(value.channel)
  );
}

export function draftBrief(message: InboundMessage): string {
  return `A contact just wrote to the sub-account: a new ${message.channel} message in conversation ${message.conversationId} (contact ${message.contactId}${message.messageId ? `, message ${message.messageId}` : ""}).
Read the conversation's latest messages with the conversations skill, then draft a reply and send it on the same channel with conversations.send-a-new-message: it waits for a person to approve it, so draft it as you would send it. Say in one line what the contact wants. If no reply is needed (spam, a thank-you, an automated message, a contact who opted out), send nothing and say why.`;
}

const OPEN = new Set(["queued", "working", "needs_you"]);

export interface InboxDrafts {
  /**
   * Starts a draft thread for a new message, unless one is open for the conversation.
   * `requestContext` is the run's: the host's identity for the member drafts run as, and the
   * taint. Resolves once the thread exists (or was skipped), not when the draft is done.
   */
  draft(
    message: InboundMessage,
    requestContext: RequestContext,
  ): Promise<{ threadId: string; started: boolean } | { skipped: "invalid" }>;
}

export function createInboxDrafts({
  storage,
  threads,
  resourceId,
  agent,
}: {
  storage: MastraStorage;
  threads: Pick<WorkThreads, "start">;
  /** The client's memory resource (`clientResource`). */
  resourceId: string;
  /** The agent that drafts: the Conversations agent. */
  agent: ThreadAgent;
}): InboxDrafts {
  const memory = async () => {
    const store = await storage.getStore("memory");
    if (!store) throw new Error("inbox drafts need a memory store");
    return store;
  };
  /** One decision per conversation at a time, so two messages at once start one thread. */
  const turns = new Map<string, Promise<unknown>>();

  /** The sub-account's chat (its newest), which reports go to; made when it has none yet. */
  async function mainChat(): Promise<string> {
    const store = await memory();
    const { threads: all } = await store.listThreads({ perPage: false, filter: { resourceId } });
    const chats = all
      .filter((t) => !workThreadOf(t) && siteOf(t) === undefined)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const newest = chats[0];
    if (newest) return newest.id;
    const id = globalThis.crypto.randomUUID();
    const now = new Date();
    await store.saveThread({
      thread: { id, resourceId, title: "Chat", createdAt: now, updatedAt: now, metadata: {} },
    });
    return id;
  }

  async function openDraft(conversationId: string): Promise<string | undefined> {
    const store = await memory();
    const { threads: all } = await store.listThreads({ perPage: false, filter: { resourceId } });
    return all.find((t) => {
      const info = workThreadOf(t);
      const tagged = (t.metadata as Record<string, unknown> | undefined)?.[INBOX_CONVERSATION_KEY];
      return info && tagged === conversationId && OPEN.has(info.status);
    })?.id;
  }

  async function decide(message: InboundMessage, requestContext: RequestContext) {
    const open = await openDraft(message.conversationId);
    if (open) return { threadId: open, started: false };
    const started = await threads.start({
      resourceId,
      parentThreadId: await mainChat(),
      title: `Reply to a new ${message.channel} message`,
      brief: draftBrief(message),
      agent,
      requestContext,
    });
    await (await memory()).updateThreadMetadata({
      id: started.threadId,
      update: () => ({ [INBOX_CONVERSATION_KEY]: message.conversationId }),
    });
    return { threadId: started.threadId, started: true };
  }

  return {
    draft(message, requestContext) {
      if (!isInboundMessage(message)) return Promise.resolve({ skipped: "invalid" as const });
      const key = message.conversationId;
      const step = () => decide(message, requestContext);
      const run = (turns.get(key) ?? Promise.resolve()).then(step, step);
      const settled = run.catch(() => undefined);
      turns.set(key, settled);
      void settled.then(() => {
        if (turns.get(key) === settled) turns.delete(key);
      });
      return run;
    },
  };
}
