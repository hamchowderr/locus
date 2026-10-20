import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { SITE_BUILDER_MODE_ID } from "@locus/builder";
import { redirect } from "next/navigation";
import { Notice } from "@/app/ui";
import { ChatWithPreview } from "@/components/chat-preview/chat-with-preview";
import { chatKitEnabled } from "@/lib/chat-kit";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { activeSiteIdForSession, siteNames } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { previewSite } from "../sites/[siteId]/actions";

/** Starting a preview can install the site's packages first. */
export const maxDuration = 300;

/**
 * The modes the agent server's controller has for every client: Locus's default "act"
 * mode and the site builder, which works on the site chosen on the Sites page.
 */
const CHAT_MODES = [
  { id: "act", name: "Chat" },
  { id: SITE_BUILDER_MODE_ID, name: "Site builder" },
] as const;

export default async function ChatPage() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fchat");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const ctx = sessionContext(current);
  const client = await resolveActiveClient(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");

  if (!chatKitEnabled()) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-4">
        <div className="mt-6">
          <Notice tone="info">
            The chat isn't turned on here yet. It needs Locus's chat server, which this site doesn't
            have.
          </Notice>
        </div>
      </div>
    );
  }

  // The site the builder works on (chosen with "Build this site"), shown live beside the chat.
  const siteId = client.location.siteBuilder
    ? await activeSiteIdForSession(locus().db, ctx, client)
    : null;
  const name = siteId
    ? ((await siteNames(siteBuilderDeps(), client, [siteId]).catch(() => null))?.get(siteId) ??
      "Untitled site")
    : null;

  // The chat kit's project chat: one main chat whose agent hands longer work to threads of
  // their own, each shown under the message that started it. Its requests go through this
  // site's /api/agent-controller routes, which the agent server checks against the sign-in.
  return (
    <ChatWithPreview
      modes={CHAT_MODES}
      site={siteId && name ? { id: siteId, name } : null}
      start={siteId ? previewSite.bind(null, siteId, null) : null}
    />
  );
}
