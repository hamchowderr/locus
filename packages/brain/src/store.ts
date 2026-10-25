import type { TenantDb } from "@locus/db";
import { brainFile, brainFileVersion } from "@locus/db/tenant";
import { and, asc, desc, eq } from "drizzle-orm";

/** The client database, or a transaction on it. */
type Tx = Parameters<Parameters<TenantDb["transaction"]>[0]>[0];
type Executor = TenantDb | Tx;

export interface NoteRow {
  path: string;
  content: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface NoteVersion {
  path: string;
  number: number;
  /** Null when this version deleted the note. */
  content: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export async function getNote(db: Executor, path: string): Promise<NoteRow | undefined> {
  const [row] = await db.select().from(brainFile).where(eq(brainFile.path, path));
  return row;
}

/** Every note's path and size, by path. Content is left out: listings never need it. */
export async function listNotePaths(
  db: Executor,
): Promise<{ path: string; size: number; updatedAt: Date }[]> {
  return db
    .select({ path: brainFile.path, size: brainFile.size, updatedAt: brainFile.updatedAt })
    .from(brainFile)
    .orderBy(asc(brainFile.path));
}

export async function listNotes(db: Executor): Promise<NoteRow[]> {
  return db.select().from(brainFile).orderBy(asc(brainFile.path));
}

/**
 * Writes or deletes (`content: null`) one note and records it as a new version. Callers check
 * the path first; this only stores.
 */
export async function putNote(
  db: Executor,
  path: string,
  content: string | null,
  actor: string | null,
  now = new Date(),
): Promise<void> {
  const [last] = await db
    .select({ number: brainFileVersion.number })
    .from(brainFileVersion)
    .where(eq(brainFileVersion.path, path))
    .orderBy(desc(brainFileVersion.number))
    .limit(1);
  await db.insert(brainFileVersion).values({
    path,
    number: (last?.number ?? 0) + 1,
    content,
    createdAt: now,
    createdBy: actor,
  });
  if (content === null) {
    await db.delete(brainFile).where(eq(brainFile.path, path));
    return;
  }
  const size = Buffer.byteLength(content, "utf8");
  await db
    .insert(brainFile)
    .values({ path, content, size, createdAt: now, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: brainFile.path,
      set: { content, size, updatedAt: now, updatedBy: actor },
    });
}

/** A note's history, newest first. Includes deletions, so a deleted note can come back. */
export async function listNoteVersions(db: TenantDb, path: string): Promise<NoteVersion[]> {
  return db
    .select()
    .from(brainFileVersion)
    .where(eq(brainFileVersion.path, path))
    .orderBy(desc(brainFileVersion.number));
}

/**
 * Puts a note back as it was at `number`, saved as a new version so the restore can be undone
 * too. Restoring a deletion deletes the note.
 */
export async function restoreNoteVersion(
  db: TenantDb,
  path: string,
  number: number,
  actor: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(brainFileVersion)
      .where(and(eq(brainFileVersion.path, path), eq(brainFileVersion.number, number)));
    if (!version) throw new Error(`${path} has no version ${number}.`);
    await putNote(tx, path, version.content, actor);
  });
}
