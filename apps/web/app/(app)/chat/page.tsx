import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { redirect } from "next/navigation";
import { Notice } from "@/app/ui";
import { BrainTab } from "@/components/brain-tab";
import { InboxTab } from "@/components/inbox-tab";
import { LibraryTab } from "@/components/library-tab";
import { MainChat } from "@/components/main-chat";
import { appConnectionsFromEnv } from "@/lib/apps";
import { chatKitEnabled } from "@/lib/chat-kit";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { setupStepFor } from "@/lib/onboarding";

/**
 * The main chat always runs as the supervisor, with no picker: it answers questions and hands
 * every change to an agent in a thread. Each turn names the mode, since a site's chat (on its
 * page under Sites) runs the same session in the site builder's mode.
 */
const CHAT_MODES = [{ id: "supervisor", name: "Chat" }] as const;

export default async function ChatPage() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fchat");
  if (await setupStepFor(current)) redirect("/onboarding");
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");

  return (
    <div className="flex h-full flex-col">
      {chatKitEnabled() ? (
        // The chat kit's project chat: the sub-account's one chat, handing longer work to
        // threads, with its Library, Brain and Inbox beside them. Its requests go through this site's
        // /api/agent-controller routes, which the agent server checks against the sign-in.
        // The menu's layout already provides the tooltips it needs.
        <MainChat
          className="min-h-0 flex-1"
          modes={CHAT_MODES}
          library={<LibraryTab client={client} />}
          brain={<BrainTab client={client} />}
          inbox={<InboxTab />}
          connectorScope={appConnectionsFromEnv() ? client.location.id : undefined}
        />
      ) : (
        <div className="mx-auto mt-6 w-full max-w-4xl px-4">
          <Notice tone="info">
            The chat isn't turned on here yet. It needs Locus's chat server, which this site doesn't
            have.
          </Notice>
        </div>
      )}
    </div>
  );
}
