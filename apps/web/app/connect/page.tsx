import { ClientAccessDenied, listAccessibleClients, requireAgencyManager } from "@locus/auth";
import { agencyGhlConnection } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ghlMode } from "@/lib/connect";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { syncClients } from "../actions";
import { Button, Notice, Page } from "../ui";

const MESSAGES: Record<string, string> = {
  state: "That sign-in to GoHighLevel expired or didn't match. Try again.",
  ghl: "GoHighLevel refused the connection. Try again.",
  "not-configured": "GoHighLevel isn't set up on this deployment yet.",
};

export default async function Connect({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    connected?: string;
    synced?: string;
    reactivated?: string;
  }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fconnect");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, connected, synced, reactivated } = await searchParams;
  const ctx = sessionContext(current);

  const manager = await requireAgencyManager(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!manager) {
    return (
      <Page title="GoHighLevel">
        <Notice tone="info">Only owners and admins connect GoHighLevel.</Notice>
      </Page>
    );
  }
  const [connection] = await locus()
    .db.select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, manager.organizationId));
  const clients = await listAccessibleClients(locus().db, ctx);
  let mode: string;
  try {
    mode = ghlMode();
  } catch (e) {
    if (!(e instanceof NotConfigured)) throw e;
    mode = "not configured";
  }

  return (
    <Page title="GoHighLevel">
      {mode === "stub" && (
        <Notice tone="info">
          Using a pretend agency (GHL_MODE=stub) — no GoHighLevel account is involved.
        </Notice>
      )}
      {error && <Notice tone="error">{MESSAGES[error] ?? error}</Notice>}
      {connected !== undefined && (
        <Notice tone="info">Connected. {connected} new clients added.</Notice>
      )}
      {synced !== undefined && (
        <Notice tone="info">
          Synced. {synced} new clients added
          {reactivated && reactivated !== "0"
            ? `, ${reactivated} back after being uninstalled`
            : ""}
          .
        </Notice>
      )}

      {connection ? (
        <>
          <p className="text-neutral-600">
            Connected to {connection.companyName ?? "your GoHighLevel agency"} · {clients.length}{" "}
            active clients.
          </p>
          <form action={syncClients}>
            <Button>Sync clients now</Button>
          </form>
          <p className="text-sm text-neutral-600">
            New sub-accounts also appear on their own when Locus is installed on them.
          </p>
        </>
      ) : (
        <p className="text-neutral-600">
          Connect your GoHighLevel agency and every sub-account you install Locus on becomes a
          client here.
        </p>
      )}
      <a
        href="/api/connect/crm/start"
        className="block w-full rounded-md border border-neutral-300 px-4 py-2 text-center text-sm font-medium"
      >
        {connection ? "Reconnect GoHighLevel" : "Connect GoHighLevel"}
      </a>
    </Page>
  );
}
