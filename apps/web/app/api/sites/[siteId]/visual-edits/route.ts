import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { VisualEdits, WorkspaceError } from "@locus/studio";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { saveVisualEdits } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";

/** Big enough for a few hundred edits; a body that says it is bigger is refused unread. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Saves what a person changed by clicking things in a site's preview (Visual edits) as a new
 * version. No AI is involved. The client is the session's active one and the site must be
 * that client's (`saveVisualEdits` runs the staff check again). JSON only, so a form on
 * another site can't post here with the person's cookie.
 */
export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return Response.json({ error: "Send the changes as JSON." }, { status: 415 });
  }
  const current = await currentSession();
  if (!current) return Response.json({ error: "Sign in first." }, { status: 401 });
  const tooMany = () =>
    Response.json({ error: "That's too many changes at once." }, { status: 413 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooMany();
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return tooMany();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Send the changes as JSON." }, { status: 400 });
  }
  const fields = (body ?? {}) as { edits?: unknown; draft?: unknown };
  const edits = VisualEdits.safeParse(fields.edits);
  const draft = typeof fields.draft === "string" ? fields.draft.slice(0, 128) : "";
  if (!edits.success) {
    return Response.json({ error: "Those changes couldn't be read." }, { status: 400 });
  }
  try {
    const client = await resolveActiveClient(locus().db, sessionContext(current));
    const saved = await saveVisualEdits(siteBuilderDeps(), client, siteId, edits.data, draft);
    return Response.json(saved, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ClientAccessDenied) {
      return Response.json({ error: "You can't edit this site." }, { status: 403 });
    }
    if (error instanceof WorkspaceError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NotConfigured) {
      return Response.json({ error: "Locus isn't set up here yet." }, { status: 503 });
    }
    throw error;
  }
}
