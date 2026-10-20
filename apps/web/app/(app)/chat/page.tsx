import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { redirect } from "next/navigation";
import { Notice } from "@/app/ui";
import { ProjectChat } from "@/components/chat-project/project-chat";
import { chatKitEnabled } from "@/lib/chat-kit";
import { currentSession, locus, sessionContext } from "@/lib/locus";

/**
 * The main chat always runs in Locus's "act" mode, with no picker. Each turn names it, since
 * a site's chat (on its page under Sites) runs the same session in the site builder's mode.
 */
const CHAT_MODES = [{ id: "act", name: "Chat" }] as const;

export default async function ChatPage() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fchat");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-4 py-4">
      {chatKitEnabled() ? (
        // The chat kit's project chat: one main chat whose agent hands longer work to threads
        // of their own, each shown under the message that started it. Its requests go through
        // this site's /api/agent-controller routes, which the agent server checks against the
        // sign-in. The menu's layout already provides the tooltips it needs.
        <ProjectChat className="min-h-0 flex-1" modes={CHAT_MODES} />
      ) : (
        <div className="mt-6">
          <Notice tone="info">
            The chat isn't turned on here yet. It needs Locus's chat server, which this site doesn't
            have.
          </Notice>
        </div>
      )}
    </div>
  );
}
