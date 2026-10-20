import { ClientAccessDenied } from "@locus/auth";
import { redirect } from "next/navigation";
import { appConnectionsFromEnv, clientApps } from "@/lib/apps";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { Notice, Page } from "../ui";
import { connectApp, disconnectApp } from "./actions";

/** What the chat can do with each app, in plain words. */
const USES: Record<string, string> = {
  gmail: "Read and send email.",
  googlecalendar: "See and book calendar events.",
  slack: "Read and post messages.",
};

export default async function Apps({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string; disconnected?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fapps");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, connected, disconnected } = await searchParams;
  const connections = appConnectionsFromEnv();
  if (!connections) {
    return (
      <Page title="Connected apps">
        <Notice tone="info">Connected apps aren't set up here yet.</Notice>
      </Page>
    );
  }
  const ctx = sessionContext(current);
  const listing = await clientApps(locus().db, ctx, connections).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    console.error("Apps page: listing failed", e);
    return { problem: true as const };
  });
  if (!listing) redirect("/clients");

  return (
    <Page title="Connected apps">
      {error && <Notice tone="error">{error}</Notice>}
      {connected && <Notice tone="info">Back from the app's sign-in. Its status is below.</Notice>}
      {disconnected && <Notice tone="info">App disconnected.</Notice>}
      <p className="text-neutral-600">
        The chat can use the apps this client connects. Reading runs right away; sending or changing
        anything waits for someone to approve it.
      </p>
      {"problem" in listing ? (
        <Notice tone="error">Locus couldn't load the apps just now. Reload to try again.</Notice>
      ) : (
        <ul className="space-y-3">
          {listing.apps.map((app) => (
            <li key={app.toolkit} className="rounded-md border border-neutral-200 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{app.name}</p>
                  <p className="text-sm text-neutral-600">
                    {USES[app.toolkit]} {app.connected ? "Connected." : "Not connected."}
                  </p>
                </div>
                {listing.manager && (
                  <form action={app.connected ? disconnectApp : connectApp}>
                    <input type="hidden" name="toolkit" value={app.toolkit} />
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-3 py-1 text-sm"
                    >
                      {app.connected ? "Disconnect" : "Connect"}
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!("problem" in listing) && !listing.manager && (
        <p className="text-sm text-neutral-600">Only owners and admins can connect apps.</p>
      )}
    </Page>
  );
}
