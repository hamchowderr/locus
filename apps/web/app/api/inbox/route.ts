import { ClientAccessDenied, inboxDraftsFor, resolveActiveClient } from "@locus/auth";
import { listInbox } from "@locus/connect";
import { connectDeps } from "@/lib/connect";
import { readInbox } from "@/lib/inbox";
import { currentSession, locus, sessionContext } from "@/lib/locus";

/**
 * The chat's Inbox tab: the active sub-account's latest GHL conversations, read live from GHL
 * for this request and never stored. The sub-account is the session's active one, after the
 * staff check; nothing in the request names it. Read only, so a GET; the browser asks when the
 * tab is shown.
 */
export async function GET() {
  const current = await currentSession();
  if (!current) return Response.json({ error: "Sign in first." }, { status: 401 });
  try {
    const { db } = locus();
    const client = await resolveActiveClient(db, sessionContext(current));
    const view = await readInbox(
      () => listInbox(connectDeps(), client),
      async () => (await inboxDraftsFor(db, client.location.id)) !== null,
    );
    return Response.json(
      { ...view, ghlLocationId: client.location.ghlLocationId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ClientAccessDenied) {
      return Response.json({ error: "Pick a sub-account first." }, { status: 403 });
    }
    throw error;
  }
}
