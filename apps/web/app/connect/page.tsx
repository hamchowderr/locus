import { ClientAccessDenied, listAccessibleClients, requireAgencyManager } from "@locus/auth";
import { agencyGhlConnection, githubInstallation, hostConnection } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { serviceMode } from "@/lib/connect";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { syncClients } from "../actions";
import { Button, Notice, Page } from "../ui";

const MESSAGES: Record<string, string> = {
  state: "That sign-in to GoHighLevel expired or didn't match. Try again.",
  ghl: "GoHighLevel refused the connection. Try again.",
  "not-configured": "GoHighLevel isn't set up on this deployment yet.",
  "github-state": "That GitHub install expired or didn't start from Locus. Try again from here.",
  "github-not-configured": "GitHub isn't set up on this deployment yet.",
  "vercel-state": "That Vercel install expired or didn't start from Locus. Try again from here.",
  "vercel-not-configured": "Vercel isn't set up on this deployment yet.",
};

const LINK =
  "block w-full rounded-md border border-neutral-300 px-4 py-2 text-center text-sm font-medium";

function modeOf(variable: "GHL_MODE" | "GITHUB_MODE" | "VERCEL_MODE") {
  try {
    return serviceMode(variable);
  } catch (e) {
    if (!(e instanceof NotConfigured)) throw e;
    return "not configured";
  }
}

export default async function Connect({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    connected?: string;
    synced?: string;
    reactivated?: string;
    github?: string;
    vercel?: string;
  }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fconnect");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, connected, synced, reactivated, github, vercel } = await searchParams;
  const ctx = sessionContext(current);

  const manager = await requireAgencyManager(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!manager) {
    return (
      <Page title="Connections">
        <Notice tone="info">Only owners and admins connect GoHighLevel, GitHub and Vercel.</Notice>
      </Page>
    );
  }
  const [connection] = await locus()
    .db.select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, manager.organizationId));
  const [installation] = await locus()
    .db.select()
    .from(githubInstallation)
    .where(eq(githubInstallation.organizationId, manager.organizationId));
  const [host] = await locus()
    .db.select()
    .from(hostConnection)
    .where(eq(hostConnection.organizationId, manager.organizationId));
  const clients = await listAccessibleClients(locus().db, ctx);
  const stubs = (["GHL_MODE", "GITHUB_MODE", "VERCEL_MODE"] as const).filter(
    (v) => modeOf(v) === "stub",
  );

  return (
    <Page title="Connections">
      {stubs.length > 0 && (
        <Notice tone="info">
          Pretend accounts in use ({stubs.map((v) => `${v}=stub`).join(", ")}) — no real account is
          involved.
        </Notice>
      )}
      {error && <Notice tone="error">{MESSAGES[error] ?? error}</Notice>}
      {github && <Notice tone="info">GitHub connected: {github}.</Notice>}
      {vercel && <Notice tone="info">Vercel connected: {vercel}.</Notice>}

      <h2 className="text-lg font-semibold">GoHighLevel</h2>
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
      <a href="/api/connect/crm/start" className={LINK}>
        {connection ? "Reconnect GoHighLevel" : "Connect GoHighLevel"}
      </a>

      <h2 className="pt-4 text-lg font-semibold">GitHub</h2>
      <p className="text-neutral-600">
        {installation
          ? `Connected to ${installation.orgLogin}. Sites will get their own repositories there.`
          : "Install Locus on your GitHub organisation. It can only reach repositories it creates, never your existing code."}
      </p>
      <a href="/api/connect/github/start" className={LINK}>
        {installation ? "Reconnect GitHub" : "Connect GitHub"}
      </a>

      <h2 className="pt-4 text-lg font-semibold">Vercel</h2>
      <p className="text-neutral-600">
        {host?.provider === "vercel"
          ? `Connected to ${host.accountName ?? host.teamId}. Sites will deploy to this team.`
          : "Connect the Vercel team your clients' sites should deploy to."}
      </p>
      <a href="/api/connect/vercel/start" className={LINK}>
        {host?.provider === "vercel" ? "Reconnect Vercel" : "Connect Vercel"}
      </a>
    </Page>
  );
}
