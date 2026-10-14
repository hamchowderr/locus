import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MinimalChat } from "@/components/chat-minimal/minimal-chat";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { Notice } from "../ui";

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
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-6 py-6">
      <p className="text-sm">
        <Link href="/" className="underline">
          Locus
        </Link>{" "}
        · Chat about <strong>{client.location.name}</strong>
      </p>
      {process.env.LOCUS_AGENT_URL ? (
        // The chat kit's conversation. Its requests go through this site's
        // /api/agent-controller routes, which the agent server checks against the sign-in.
        <MinimalChat className="mt-4 min-h-0 flex-1" />
      ) : (
        <div className="mt-6">
          <Notice tone="info">The chat isn't set up here yet.</Notice>
        </div>
      )}
    </main>
  );
}
