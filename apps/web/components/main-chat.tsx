"use client";

import type { ToolViews } from "@/components/chat/tool-steps";
import { ProjectChat } from "@/components/chat-project/project-chat";
import type { ThreadOutput } from "@/components/chat-project/thread-groups";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { chatShowsInFull, chatStep } from "@/lib/chat-steps";

/** The main chat's tools as plain step rows. Made once, so the chat's views stay put. */
const TOOL_VIEWS: ToolViews = { step: chatStep, plain: chatShowsInFull };

/** A site's own conversation lives on its page under Sites, not in this list. */
const isChat = (t: ThreadItem) => !t.parentThreadId && !t.siteId;

/** A thread that builds a site opens it: the preview, with the thread's chat beside it. */
const outputsOf = (t: ThreadItem): ThreadOutput[] =>
  t.siteId
    ? [
        {
          kind: "site",
          label: "Open site",
          href: `/sites/${encodeURIComponent(t.siteId)}?thread=${encodeURIComponent(t.id)}`,
        },
      ]
    : [];

/**
 * The sub-account's chats: the chat kit's project chat, with Locus's tools told in plain words
 * and sites' conversations left out of the list.
 */
export function MainChat({
  className,
  modes,
}: {
  className?: string | undefined;
  modes: ReadonlyArray<{ id: string; name: string }>;
}) {
  return (
    <ProjectChat
      {...(className ? { className } : {})}
      modes={modes}
      toolViews={TOOL_VIEWS}
      isChat={isChat}
      outputsOf={outputsOf}
    />
  );
}
