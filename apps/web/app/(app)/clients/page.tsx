import {
  ClientAccessDenied,
  listAccessibleClients,
  requireAgencyManager,
  resolveActiveClient,
} from "@locus/auth";
import { redirect } from "next/navigation";
import { chooseClient, switchSiteBuilder } from "@/app/actions";
import { Button, Notice, Page } from "@/app/ui";
import { checkClientConnection } from "@/lib/connect";
import { currentSession, locus, sessionContext } from "@/lib/locus";

export default async function Clients({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; builder?: string; changed?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, builder, changed } = await searchParams;
  const ctx = sessionContext(current);
  const clients = await listAccessibleClients(locus().db, ctx).catch((e) => {
    // Removed from the agency: nothing to choose, rather than an error page.
    if (e instanceof ClientAccessDenied) return [];
    throw e;
  });
  const manager = await requireAgencyManager(locus().db, ctx).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const active = await resolveActiveClient(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  const ghl = active ? await checkClientConnection(active) : null;
  const count = Number(changed) || 0;
  return (
    <Page
      title="Sub-accounts"
      description="The GoHighLevel sub-accounts you work on. Choose one to open its chat."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {active &&
        ghl &&
        (ghl.ok ? (
          <Notice tone="info">
            {active.location.name}: GoHighLevel connected to {ghl.name || "this sub-account"}.
          </Notice>
        ) : (
          <Notice tone="error">
            {active.location.name}: can't reach GoHighLevel. {ghl.reason}
          </Notice>
        ))}
      {(builder === "on" || builder === "off") && (
        <Notice tone="info">
          Site builder turned {builder} for {count} {count === 1 ? "sub-account" : "sub-accounts"}.
        </Notice>
      )}
      {clients.length === 0 ? (
        <Notice tone="info">
          No sub-accounts you can work on yet. They appear once your agency connects GoHighLevel,
          and an owner or admin chooses yours on the Team page.
        </Notice>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {clients.map((client) => (
            <li key={client.id}>
              <form action={chooseClient}>
                <input type="hidden" name="locationId" value={client.id} />
                <button type="submit" className="w-full px-4 py-3 text-left hover:bg-neutral-50">
                  {client.name}
                  {!client.siteBuilder && (
                    <span className="text-sm text-neutral-500"> · site builder off</span>
                  )}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {manager && clients.length > 0 && (
        <form
          action={switchSiteBuilder}
          className="space-y-3 rounded-md border border-neutral-200 p-4"
        >
          <h2 className="font-semibold">Site builder</h2>
          <p className="text-sm text-neutral-600">
            Tick sub-accounts, then turn the site builder on or off for all of them. With it off,
            nobody can create, copy in or build that sub-account's sites. Sites already live stay
            live.
          </p>
          <div className="space-y-1">
            {clients.map((client) => (
              <label key={client.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="locationId" value={client.id} />
                {client.name}
                <span className="text-neutral-500">· {client.siteBuilder ? "on" : "off"}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-3">
            <Button name="on" value="yes">
              Turn on
            </Button>
            <Button name="on" value="no">
              Turn off
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}
