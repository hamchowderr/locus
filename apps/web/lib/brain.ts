import type { AuthorizedClient } from "@locus/auth";
import {
  BRAIN_FOLDERS,
  BrainFilesystem,
  BrainPathError,
  getNote,
  INSTRUCTIONS_FILE,
  listNotes,
  listNoteVersions,
  type NoteVersion,
  normalizeBrainPath,
  restoreNoteVersion,
  SETUP_NOTE,
  summarize,
} from "@locus/brain";
import { leaseClientDb, openClientDb } from "@locus/builder/host";
import { provisionerFromEnv, type TenantDb } from "@locus/db";
import { configured } from "./connect.ts";

/**
 * The client's brain as people see it: the Brain tab and page. Notes they save are theirs
 * (`user:<id>`), so the history says who changed what, and agents see the change on their next
 * step. Every call takes a client authorized just now; nothing here names one.
 */
export interface BrainDeps {
  openClientDb: (client: AuthorizedClient) => Promise<TenantDb>;
}

/** The brain's deps from the deployment's environment. Server-side only. */
export function brainDeps(): BrainDeps {
  const provisioner = configured(() => provisionerFromEnv(".data/tenants"));
  return { openClientDb: (client) => openClientDb(provisioner, client) };
}

export type BrainListedNote = {
  path: string;
  /** The note's name: its file name without `.md`. */
  name: string;
  summary: string;
  updatedAt: Date;
  updatedBy: string | null;
};

export type BrainOverview = {
  instructions: BrainListedNote | null;
  folders: { name: string; purpose: string; notes: BrainListedNote[] }[];
};

export type BrainNoteView = {
  path: string;
  /** Null when the note was deleted; its history can bring it back. */
  content: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  versions: NoteVersion[];
};

/** Something the person can fix: a bad name, a note that isn't there. */
export class BrainInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainInputError";
  }
}

/**
 * The brain's refusals (a bad path, a note too long, a name taken, a note changed meanwhile) as
 * something the person can fix. They arrive as Mastra filesystem errors, which carry a `code`
 * and the path; anything else is a bug and stays as it is.
 */
function asInput(e: unknown, name: string): unknown {
  if (e instanceof BrainPathError) return new BrainInputError(e.message);
  if (!(e instanceof Error) || typeof (e as { code?: unknown }).code !== "string") return e;
  if (!("path" in e)) return e;
  if (e.name === "StaleFileError") {
    return new BrainInputError(
      "Someone changed this note while you had it open. Your text wasn't saved; copy it, reload the note and try again.",
    );
  }
  if (e.name === "FileExistsError") {
    return new BrainInputError(`There's already a note called "${name}" in that folder.`);
  }
  if (e.name === "FileNotFoundError") return new BrainInputError("That note is already gone.");
  return new BrainInputError(e.message);
}

/** Who made a change, in words: the agent, the person looking, or someone else on the team. */
export function changedBy(actor: string | null, userId: string): string {
  if (actor === null) return "Locus";
  if (actor.startsWith("agent:")) return "The agent";
  if (actor === personActor(userId)) return "You";
  return "Someone on your team";
}

export const personActor = (userId: string) => `user:${userId}`;

async function withTenant<T>(
  deps: BrainDeps,
  client: AuthorizedClient,
  use: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const { db, release } = await leaseClientDb(deps.openClientDb, client);
  try {
    return await use(db);
  } finally {
    release();
  }
}

/** A path the person typed or a link carried, as the brain stores it; refused when not a note. */
export function notePath(input: string): string {
  try {
    const path = normalizeBrainPath(input);
    if (path === INSTRUCTIONS_FILE) return path;
    const [top, ...rest] = path.split("/");
    if (!top || !Object.hasOwn(BRAIN_FOLDERS, top) || rest.length === 0 || !path.endsWith(".md")) {
      throw new BrainPathError(`"${input}" isn't a note in one of the brain's folders.`);
    }
    return path;
  } catch (e) {
    if (e instanceof BrainPathError) throw new BrainInputError(e.message);
    throw e;
  }
}

/** A new note's path from the folder and name in the form: "Opening hours" → business/opening-hours.md. */
export function newNotePath(folder: string, name: string): string {
  if (!Object.hasOwn(BRAIN_FOLDERS, folder))
    throw new BrainInputError("Choose one of the brain's folders.");
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new BrainInputError("Give the note a name.");
  return `${folder}/${slug}.md`;
}

/**
 * A line that tells one version from the one before it: the first line it added, or else its
 * first line of text. Headings are skipped, so most notes don't all read as their title.
 */
export function versionHint(content: string, older: string | null | undefined): string {
  const lines = content.split("\n").map((l) => l.trim());
  const text = lines.filter((l) => l && !l.startsWith("#"));
  const before = new Set((older ?? "").split("\n").map((l) => l.trim()));
  const added = text.find((l) => !before.has(l));
  return (added ?? text[0] ?? "").slice(0, 80);
}

const listed = (n: {
  path: string;
  content: string;
  updatedAt: Date;
  updatedBy: string | null;
}): BrainListedNote => ({
  path: n.path,
  name: (n.path.split("/").at(-1) ?? n.path).replace(/\.md$/, ""),
  summary: summarize(n.content),
  updatedAt: n.updatedAt,
  updatedBy: n.updatedBy,
});

/** Every folder, in the brain's order, with its notes by name; and instructions.md on its own. */
export async function brainOverview(
  deps: BrainDeps,
  client: AuthorizedClient,
): Promise<BrainOverview> {
  const notes = await withTenant(deps, client, listNotes);
  const instructions = notes.find((n) => n.path === INSTRUCTIONS_FILE);
  return {
    instructions: instructions ? listed(instructions) : null,
    folders: Object.entries(BRAIN_FOLDERS).map(([name, purpose]) => ({
      name,
      purpose,
      notes: notes.filter((n) => n.path.startsWith(`${name}/`)).map(listed),
    })),
  };
}

/** One note and its history, newest first; null when it never existed. */
export async function brainNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  input: string,
): Promise<BrainNoteView | null> {
  const path = notePath(input);
  return withTenant(deps, client, async (db) => {
    const [note, versions] = await Promise.all([getNote(db, path), listNoteVersions(db, path)]);
    if (!note && versions.length === 0) return null;
    return {
      path,
      content: note?.content ?? null,
      updatedAt: note?.updatedAt ?? null,
      updatedBy: note?.updatedBy ?? null,
      versions,
    };
  });
}

/** Writes a note as the person, creating it if it's new. Returns its path. */
export async function saveBrainNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  userId: string,
  input: string,
  content: string,
  /** When the note was last changed as the person saw it; a newer change is never overwritten. */
  seen?: Date,
): Promise<string> {
  const path = notePath(input);
  await withTenant(deps, client, async (db) => {
    const brain = new BrainFilesystem(db, { actor: personActor(userId) });
    try {
      await brain.writeFile(
        path,
        content.replace(/\r\n/g, "\n"),
        seen ? { expectedMtime: seen } : undefined,
      );
    } catch (e) {
      throw asInput(e, path);
    }
  });
  return path;
}

/** Starts a note as the person, titled with its name; refuses a name already in the folder. */
export async function createBrainNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  userId: string,
  folder: string,
  name: string,
): Promise<string> {
  const path = newNotePath(folder, name);
  await withTenant(deps, client, async (db) => {
    const brain = new BrainFilesystem(db, { actor: personActor(userId) });
    try {
      await brain.writeFile(path, `# ${name.trim()}\n\n`, { overwrite: false });
    } catch (e) {
      throw asInput(e, name.trim());
    }
  });
  return path;
}

/** Deletes a note as the person; its history keeps it, so it can come back. */
export async function deleteBrainNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  userId: string,
  input: string,
): Promise<void> {
  const path = notePath(input);
  await withTenant(deps, client, async (db) => {
    const brain = new BrainFilesystem(db, { actor: personActor(userId) });
    try {
      await brain.deleteFile(path);
    } catch (e) {
      throw asInput(e, path);
    }
  });
}

/** Puts a note back as it was at one version, saved as a new version so it can be undone too. */
export async function restoreBrainNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  userId: string,
  input: string,
  number: number,
): Promise<void> {
  const path = notePath(input);
  if (!Number.isInteger(number) || number < 1) throw new BrainInputError("Choose a version.");
  await withTenant(deps, client, async (db) => {
    const versions = await listNoteVersions(db, path);
    const version = versions.find((v) => v.number === number);
    if (!version) throw new BrainInputError("That version isn't in this note's history.");
    // Putting back a deletion would only delete the note again.
    if (version.content === null) throw new BrainInputError("Choose a version that has text.");
    await restoreNoteVersion(db, path, number, personActor(userId));
  });
}

/**
 * Saves the setup's starter note as Locus (no person or agent), unless a note is already there:
 * picking the main sub-account again never overwrites what people have since written.
 */
export async function saveSetupNote(
  deps: BrainDeps,
  client: AuthorizedClient,
  content: string,
): Promise<boolean> {
  return withTenant(deps, client, async (db) => {
    const brain = new BrainFilesystem(db);
    try {
      await brain.writeFile(SETUP_NOTE, content, { overwrite: false });
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === "FileExistsError") return false;
      throw e;
    }
  });
}

/** How many notes the client's brain holds, instructions included. */
export async function brainNoteCount(deps: BrainDeps, client: AuthorizedClient): Promise<number> {
  return withTenant(deps, client, async (db) => (await listNotes(db)).length);
}
