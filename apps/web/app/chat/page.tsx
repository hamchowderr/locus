import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { Notice } from "../ui";
import { Chat } from "./chat";

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
    <main className="mx-auto flex h-dvh max-w-2xl flex-col px-6 py-10">
      <p className="text-sm">
        <Link href="/" className="underline">
          Locus
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Chat</h1>
      <p className="text-sm text-neutral-600">
        Working on <strong>{client.location.name}</strong>.
      </p>
      {process.env.LOCUS_AGENT_URL ? (
        // The agent server takes the client from the sign-in, not from this id; it only names
        // which conversation the page opens, and any other client's is refused.
        <Chat resource={`client:${client.location.ghlLocationId}`} />
      ) : (
        <div className="mt-6">
          <Notice tone="info">The chat isn't set up here yet.</Notice>
        </div>
      )}
    </main>
  );
}
