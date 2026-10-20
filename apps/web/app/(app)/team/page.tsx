import { ClientAccessDenied, listAccessibleClients, listTeam } from "@locus/auth";
import { agencyGhlConnection } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { importStaff, inviteMember, saveMemberClients } from "@/app/actions";
import { Button, Field, Notice, Page } from "@/app/ui";
import { currentSession, locus, sessionContext } from "@/lib/locus";

export default async function Team({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    invited?: string;
    saved?: string;
    imported?: string;
    ghlOnly?: string;
  }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fteam");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error, invited, saved, imported, ghlOnly } = await searchParams;
  const ctx = sessionContext(current);

  const team = await listTeam(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!team) {
    return (
      <Page title="Team">
        <Notice tone="info">Only owners and admins manage the team.</Notice>
      </Page>
    );
  }
  const clients = await listAccessibleClients(locus().db, ctx);
  const [connection] = await locus()
    .db.select({ organizationId: agencyGhlConnection.organizationId })
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, ctx.activeOrganizationId ?? ""));

  return (
    <Page title="Team">
      {error && <Notice tone="error">{error}</Notice>}
      {invited && <Notice tone="info">Invitation sent.</Notice>}
      {saved && <Notice tone="info">Client access saved.</Notice>}
      {imported !== undefined && (
        <Notice tone="info">
          Imported client access for {imported} members from GoHighLevel.
          {ghlOnly && ghlOnly !== "0"
            ? ` ${ghlOnly} GoHighLevel staff have no Locus account yet — invite them, then import again.`
            : ""}
        </Notice>
      )}

      {connection && (
        <form action={importStaff} className="space-y-2 rounded-md border border-neutral-200 p-4">
          <p className="text-sm text-neutral-600">
            Copy which clients each member works on from GoHighLevel, matched by email. Owners and
            admins aren't changed, and nothing is synced afterwards — edit access here from then on.
          </p>
          <Button>Import client access from GoHighLevel</Button>
        </form>
      )}

      <form action={inviteMember} className="space-y-3 rounded-md border border-neutral-200 p-4">
        <Field label="Invite by email" name="email" type="email" required />
        <label className="block text-sm">
          <span className="text-neutral-700">Role</span>
          <select
            name="role"
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2"
          >
            <option value="member">Member — only the clients you choose</option>
            <option value="admin">Admin — every client</option>
          </select>
        </label>
        <Button>Send invitation</Button>
      </form>

      <ul className="space-y-3">
        {team.map((m) => (
          <li key={m.memberId} className="rounded-md border border-neutral-200 p-4">
            <p className="font-medium">
              {m.name} <span className="text-sm text-neutral-500">· {m.role}</span>
            </p>
            <p className="text-sm text-neutral-600">{m.email}</p>
            {m.unrestricted ? (
              <p className="mt-2 text-sm text-neutral-600">Works on every client.</p>
            ) : clients.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-600">No clients to assign yet.</p>
            ) : (
              <form action={saveMemberClients} className="mt-3 space-y-2">
                <input type="hidden" name="memberId" value={m.memberId} />
                {clients.map((client) => (
                  <label key={client.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="locationId"
                      value={client.id}
                      defaultChecked={m.locationIds.includes(client.id)}
                    />
                    {client.name}
                  </label>
                ))}
                <button type="submit" className="text-sm underline">
                  Save client access
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Page>
  );
}
