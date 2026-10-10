import { listAccessibleClients } from "@locus/auth";
import { redirect } from "next/navigation";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { chooseClient } from "../actions";
import { Notice, Page } from "../ui";

export default async function Clients({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { error } = await searchParams;
  const clients = await listAccessibleClients(locus().db, sessionContext(current));
  return (
    <Page title="Choose a client">
      {error && <Notice tone="error">{error}</Notice>}
      {clients.length === 0 ? (
        <Notice tone="info">
          No clients you can work on yet. Clients appear once your agency connects GoHighLevel, and
          an owner or admin chooses yours on the Team page.
        </Notice>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {clients.map((client) => (
            <li key={client.id}>
              <form action={chooseClient}>
                <input type="hidden" name="locationId" value={client.id} />
                <button type="submit" className="w-full px-4 py-3 text-left hover:bg-neutral-50">
                  {client.name}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
