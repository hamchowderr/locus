import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { INSTRUCTIONS_FILE } from "@locus/brain";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, Field, Notice, Page } from "@/app/ui";
import {
  BrainInputError,
  type BrainNoteView,
  type BrainOverview,
  brainDeps,
  brainNote,
  brainOverview,
  changedBy,
  notePath,
  versionHint,
} from "@/lib/brain";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { createNote, deleteNote, restoreNote, saveNote } from "./actions";

const when = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const DONE: Record<string, string> = {
  saved: "Saved. The agent sees it from its next step.",
  created: "Note started. Write it below and save.",
  deleted: "Deleted. Its history below can bring it back.",
  restored: "Put back. That's saved as a new version, so it can be undone too.",
};

/**
 * The sub-account's brain: every folder and note on the left, the open note on the right to read,
 * edit, delete or put back as it was. Everything here is the active client's.
 */
export default async function Brain({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A repeated parameter (?note=a&note=b) arrives as a list: the first one counts.
  const params = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbrain");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const ctx = sessionContext(current);
  const client = await resolveActiveClient(locus().db, ctx).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");

  let overview: BrainOverview;
  let note: BrainNoteView | null = null;
  let problem = params.error ?? null;
  try {
    const deps = brainDeps();
    overview = await brainOverview(deps, client);
    if (params.note) {
      note = await brainNote(deps, client, params.note).catch((e) => {
        if (e instanceof BrainInputError) {
          problem = e.message;
          return null;
        }
        throw e;
      });
    }
  } catch (e) {
    if (!(e instanceof NotConfigured)) throw e;
    return (
      <Page title="Brain">
        <Notice tone="info">Client databases aren&apos;t set up here yet.</Notice>
      </Page>
    );
  }
  const done = Object.keys(DONE).find((k) => params[k]);

  return (
    <Page
      title="Brain"
      width="wide"
      description={`What ${client.location.name}'s agents know about the business beyond GoHighLevel. They read it on every run, and save to it as they learn.`}
    >
      {problem && <Notice tone="error">{problem}</Notice>}
      {done && <Notice tone="info">{DONE[done]}</Notice>}
      <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
        <nav aria-label="Notes" className="space-y-4">
          <NoteLink
            path="instructions.md"
            name="Instructions"
            summary={overview.instructions?.summary ?? "How agents work for this sub-account"}
            open={note?.path === "instructions.md"}
          />
          {overview.folders.map((folder) => (
            <section key={folder.name} className="space-y-1">
              <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {folder.name}
              </h2>
              {folder.notes.length === 0 ? (
                <p className="px-2 text-xs text-neutral-500">{folder.purpose}</p>
              ) : (
                <ul>
                  {folder.notes.map((n) => (
                    <li key={n.path}>
                      <NoteLink
                        path={n.path}
                        name={n.name}
                        summary={n.summary}
                        open={note?.path === n.path}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <form action={createNote} className="space-y-2 rounded-md border border-neutral-200 p-3">
            <h2 className="text-sm font-semibold">New note</h2>
            <label className="block text-sm">
              <span className="text-neutral-700">Folder</span>
              <select
                name="folder"
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
              >
                {overview.folders.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <Field label="Name" name="name" required placeholder="Opening hours" />
            <Button>Start note</Button>
          </form>
        </nav>
        <div className="min-w-0">
          {params.note ? (
            <OpenNote path={params.note} note={note} userId={ctx.userId} />
          ) : (
            <p className="text-sm text-neutral-600">
              Choose a note to read or change it. What someone tells the agent lands here at once;
              notes it works out itself wait for a yes in the chat first.
            </p>
          )}
        </div>
      </div>
    </Page>
  );
}

/** The note a link names, as the brain stores it, or null when it names none. */
function normalizedOrNull(path: string): string | null {
  try {
    return notePath(path);
  } catch {
    return null;
  }
}

function NoteLink({
  path,
  name,
  summary,
  open,
}: {
  path: string;
  name: string;
  summary: string;
  open: boolean;
}) {
  return (
    <Link
      href={`/brain?note=${encodeURIComponent(path)}`}
      aria-current={open ? "page" : undefined}
      className={`block rounded-md px-2 py-1.5 ${open ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
    >
      <span className="block truncate text-sm font-medium">{name}</span>
      {summary && <span className="block truncate text-xs text-neutral-500">{summary}</span>}
    </Link>
  );
}

function OpenNote({
  path,
  note,
  userId,
}: {
  path: string;
  note: BrainNoteView | null;
  userId: string;
}) {
  const isInstructions = normalizedOrNull(path) === INSTRUCTIONS_FILE;
  // instructions.md can be written before it exists; any other note is started with the form.
  if (!note && !isInstructions) {
    return <p className="text-sm text-neutral-600">There&apos;s no note called {path}.</p>;
  }
  const shown = note?.path ?? (isInstructions ? INSTRUCTIONS_FILE : path);
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-mono text-sm text-neutral-600">{shown}</h2>
        {note?.updatedAt && (
          <p className="text-xs text-neutral-500">
            Last changed by {changedBy(note.updatedBy, userId).toLowerCase()} on{" "}
            {when.format(note.updatedAt)} UTC
          </p>
        )}
      </div>
      {note?.content === null ? (
        <Notice tone="info">
          This note was deleted. Put back a version below to bring it back.
        </Notice>
      ) : (
        <form action={saveNote} className="space-y-3">
          <input type="hidden" name="path" value={shown} />
          <input type="hidden" name="seen" value={note?.updatedAt?.getTime() ?? ""} />
          <label className="block text-sm">
            <span className="sr-only">Note</span>
            <textarea
              name="content"
              defaultValue={note?.content ?? ""}
              rows={18}
              placeholder={
                isInstructions
                  ? "How agents should work for this sub-account. Only these instructions direct them."
                  : undefined
              }
              className="block w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <div className="w-40">
            <Button>Save</Button>
          </div>
        </form>
      )}
      {note && note.versions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">History</h3>
          <ol className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {note.versions.map((v, i) => (
              <li key={v.number} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {v.content === null
                      ? "Deleted"
                      : i === note.versions.length - 1
                        ? "Created"
                        : "Changed"}{" "}
                    by {changedBy(v.createdBy, userId).toLowerCase()}
                  </span>
                  <span className="block text-xs text-neutral-500">
                    {when.format(v.createdAt)} UTC
                    {v.content ? ` · ${versionHint(v.content, note.versions[i + 1]?.content)}` : ""}
                  </span>
                </span>
                {i === 0 ? (
                  <span className="text-xs text-neutral-500">Current</span>
                ) : v.content === null ? null : (
                  <form action={restoreNote}>
                    <input type="hidden" name="path" value={shown} />
                    <input type="hidden" name="version" value={v.number} />
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
                    >
                      Put back
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {note?.content != null && (
        <form action={deleteNote} className="flex items-center gap-3 text-sm">
          <input type="hidden" name="path" value={shown} />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" value="yes" />
            Delete this note
          </label>
          <button
            type="submit"
            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700"
          >
            Delete
          </button>
        </form>
      )}
    </div>
  );
}
