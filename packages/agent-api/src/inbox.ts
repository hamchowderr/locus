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
 *
 * One draft per message, ever: each draft thread records the GHL message ids it was started for
 * or absorbed, so a retried or replayed webhook starts nothing. And at most `MAX_OPEN_DRAFTS`
 * open at once per client, so a burst of messages cannot run up an unbounded bill: past it a
 * message is skipped (it is still in GHL's inbox).
 *
 * What a draft thread keeps is the client's own, in its database: the agent's reply and its
 * one-line summary of what the contact wants, never the message as GHL sent it.
 */

import type { RequestContext } from "@mastra/core/request-context";
import type { MastraStorage } from "@mastra/core/storage";
import { siteOf, workThreadOf } from "./mastra/lib/work-thread-info.ts";
import type { ThreadAgent, WorkThreads } from "./mastra/lib/work-threads.ts";

/** The thread-metadata key naming the GHL conversation a draft thread answers. */
export const INBOX_CONVERSATION_KEY = "inboxConversation";
/** The thread-metadata key listing the GHL message ids a draft thread was started for. */
export const INBOX_MESSAGES_KEY = "inboxMessages";

/** Open drafts a client may have at once; more messages wait in GHL's inbox. */
export const MAX_OPEN_DRAFTS = 10;

/** A new message from a contact, as GHL's `InboundMessage` webhook names it. Ids only. */
export interface InboundMessage {
  conversationId: string;
  contactId: string;
  messageId: string;
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
    ID.test(value.messageId) &&
    CHANNEL.test(value.channel)
  );
}

export function draftBrief(message: InboundMessage): string {
  return `A contact just wrote to the sub-account: a new ${message.channel} message in conversation ${message.conversationId} (contact ${message.contactId}, message ${message.messageId}).
Read the conversation's latest messages with the conversations skill. Then, before you send anything, say in one line, in your own words and without quoting the message, what the contact wants. Draft a reply and send it on the same channel with conversations.send-a-new-message: it waits for a person to approve it, so draft it as you would send it. It runs only after their yes: once it returns, the reply has been sent, so say it was sent. If no reply is needed (spam, a thank-you, an automated message, a contact who opted out), send nothing and say why.`;
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
  ): Promise<{ threadId: string; started: boolean } | { skipped: "invalid" | "seen" | "busy" }>;
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
  /** One decision at a time per client, so two messages at once start one thread and one chat. */
  let turn: Promise<unknown> = Promise.resolve();

  const metaOf = (t: { metadata?: unknown }) => (t.metadata ?? {}) as Record<string, unknown>;
  const messagesOf = (t: { metadata?: unknown }) => {
    const ids = metaOf(t)[INBOX_MESSAGES_KEY];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  };

  async function decide(message: InboundMessage, requestContext: RequestContext) {
    const store = await memory();
    const { threads: all } = await store.listThreads({ perPage: false, filter: { resourceId } });
    if (all.some((t) => messagesOf(t).includes(message.messageId))) {
      return { skipped: "seen" as const };
    }
    const drafts = all.filter((t) => {
      const info = workThreadOf(t);
      return info && OPEN.has(info.status) && typeof metaOf(t)[INBOX_CONVERSATION_KEY] === "string";
    });
    const open = drafts.find((t) => metaOf(t)[INBOX_CONVERSATION_KEY] === message.conversationId);
    if (open) {
      await store.updateThreadMetadata({
        id: open.id,
        update: (thread) => ({ [INBOX_MESSAGES_KEY]: [...messagesOf(thread), message.messageId] }),
      });
      return { threadId: open.id, started: false };
    }
    if (drafts.length >= MAX_OPEN_DRAFTS) return { skipped: "busy" as const };
    const chats = all
      .filter((t) => !workThreadOf(t) && siteOf(t) === undefined)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const started = await threads.start({
      resourceId,
      parentThreadId: chats[0]?.id ?? (await newChat()),
      title: `Reply to a new ${message.channel} message`,
      brief: draftBrief(message),
      agent,
      requestContext,
    });
    await store.updateThreadMetadata({
      id: started.threadId,
      update: () => ({
        [INBOX_CONVERSATION_KEY]: message.conversationId,
        [INBOX_MESSAGES_KEY]: [message.messageId],
      }),
    });
    return { threadId: started.threadId, started: true };
  }

  /** The sub-account's chat, which reports go to, when it has none yet. */
  async function newChat(): Promise<string> {
    const id = globalThis.crypto.randomUUID();
    const now = new Date();
    await (await memory()).saveThread({
      thread: { id, resourceId, title: "Chat", createdAt: now, updatedAt: now, metadata: {} },
    });
    return id;
  }

  return {
    draft(message, requestContext) {
      if (!isInboundMessage(message)) return Promise.resolve({ skipped: "invalid" as const });
      const step = () => decide(message, requestContext);
      const run = turn.then(step, step);
      turn = run.catch(() => undefined);
      return run;
    },
  };
}
