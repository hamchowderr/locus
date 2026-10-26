import {
  brainAutoSaveFor,
  ClientAccessDenied,
  inboxDraftsFor,
  listAccessibleClients,
  requireAgencyManager,
  resolveActiveClient,
} from "@locus/auth";
import { redirect } from "next/navigation";
import {
  chooseClient,
  switchBrainAutoSave,
  switchInboxDrafts,
  switchSiteBuilder,
} from "@/app/actions";
import { Button, Notice, Page } from "@/app/ui";
import { checkClientConnection } from "@/lib/connect";
import { currentSession, locus, sessionContext } from "@/lib/locus";

export default async function Clients({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    builder?: string;
    drafts?: string;
    notes?: string;
    changed?: string;
  }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, builder, drafts, notes, changed } = await searchParams;
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
  // Read only for owners and admins, the only ones who can change it.
  const drafting = new Set(
    manager
      ? (
          await Promise.all(
            clients.map(async (c) => ((await inboxDraftsFor(locus().db, c.id)) ? c.id : null)),
          )
        ).filter((id): id is string => id !== null)
      : [],
  );
  const autoSaving = new Set(
    manager
      ? (
          await Promise.all(
            clients.map(async (c) => ((await brainAutoSaveFor(locus().db, c.id)) ? c.id : null)),
          )
        ).filter((id): id is string => id !== null)
      : [],
  );
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
      {(drafts === "on" || drafts === "off") && (
        <Notice tone="info">
          Drafted replies turned {drafts} for {count} {count === 1 ? "sub-account" : "sub-accounts"}
          .
        </Notice>
      )}
      {(notes === "on" || notes === "off") && (
        <Notice tone="info">
          Saving notes without asking turned {notes} for {count}{" "}
          {count === 1 ? "sub-account" : "sub-accounts"}.
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
      {manager && clients.length > 0 && (
        <form
          action={switchInboxDrafts}
          className="space-y-3 rounded-md border border-neutral-200 p-4"
        >
          <h2 className="font-semibold">Drafted replies</h2>
          <p className="text-sm text-neutral-600">
            When a contact texts, emails, chats or messages one of these sub-accounts, Locus drafts
            a reply in a thread of its chat. Nothing is sent until someone approves it there. Each
            draft uses AI credits. Drafts run as you, the person who turns them on.
          </p>
          <div className="space-y-1">
            {clients.map((client) => (
              <label key={client.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="locationId" value={client.id} />
                {client.name}
                <span className="text-neutral-500">· {drafting.has(client.id) ? "on" : "off"}</span>
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
      {manager && clients.length > 0 && (
        <form
          action={switchBrainAutoSave}
          className="space-y-3 rounded-md border border-neutral-200 p-4"
        >
          <h2 className="font-semibold">Notes the agent works out</h2>
          <p className="text-sm text-neutral-600">
            Each sub-account's agent keeps notes about the business. What someone tells it is saved
            at once. A note it works out by itself waits for a yes on a card in the chat, unless you
            turn this on. Changes to the sub-account's instructions always wait.
          </p>
          <div className="space-y-1">
            {clients.map((client) => (
              <label key={client.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="locationId" value={client.id} />
                {client.name}
                <span className="text-neutral-500">
                  · {autoSaving.has(client.id) ? "saves without asking" : "asks first"}
                </span>
              </label>
            ))}
          </div>
          <div className="flex gap-3">
            <Button name="on" value="yes">
              Save without asking
            </Button>
            <Button name="on" value="no">
              Ask first
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}
