"use client";

import { Brain, Inbox, Library } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import type { ToolViews } from "@/components/chat/tool-steps";
import { ProjectChat } from "@/components/chat-project/project-chat";
import type { ThreadOutput } from "@/components/chat-project/thread-groups";
import { ConnectorsMenu } from "@/components/connectors-menu";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { readConnectorsOff } from "@/lib/chat-connectors";
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
 * The sub-account's chat: the chat kit's project chat, with Locus's tools told in plain words
 * and sites' conversations kept out of it. Its panel has the sub-account's Library, Brain and Inbox
 * beside Threads. The model is the server's own, so the composer offers no picker. Where connectors
 * are set up, the composer's + menu lists them with a switch each for this chat.
 */
export function MainChat({
  className,
  modes,
  library,
  brain,
  inbox,
  connectorScope,
}: {
  className?: string | undefined;
  modes: ReadonlyArray<{ id: string; name: string }>;
  /** The Library tab's content, read on the server. */
  library: ReactNode;
  /** The Brain tab's content (the sub-account's notes), read on the server. */
  brain: ReactNode;
  /** The Inbox tab's content, which reads GHL live when the tab is shown. */
  inbox: ReactNode;
  /** The sub-account the connector switches belong to; unset where connectors aren't set up. */
  connectorScope?: string | undefined;
}) {
  // Read at send time, so a switch flipped mid-chat counts from the next message.
  const turnExtra = useCallback(() => {
    const off = connectorScope ? readConnectorsOff(connectorScope) : [];
    return off.length > 0 ? { connectorsOff: off } : undefined;
  }, [connectorScope]);
  return (
    <ProjectChat
      {...(className ? { className } : {})}
      modes={modes}
      composerMenu={connectorScope ? <ConnectorsMenu scope={connectorScope} /> : undefined}
      turnExtra={turnExtra}
      toolViews={TOOL_VIEWS}
      isChat={isChat}
      outputsOf={outputsOf}
      tabs={[
        {
          id: "library",
          label: "Library",
          icon: <Library className="size-4" aria-hidden />,
          content: library,
        },
        {
          id: "brain",
          label: "Brain",
          icon: <Brain className="size-4" aria-hidden />,
          content: brain,
        },
        {
          id: "inbox",
          label: "Inbox",
          icon: <Inbox className="size-4" aria-hidden />,
          content: inbox,
        },
      ]}
    />
  );
}
