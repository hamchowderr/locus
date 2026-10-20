import { createHash, randomUUID } from "node:crypto";
import type { TenantDb } from "@locus/db";
import { siteBlob, siteDraftFile, siteVersion, siteVersionFile } from "@locus/db/tenant";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  isTextPath,
  MAX_FILE_BYTES,
  MAX_FILES,
  normalizeSitePath,
  WorkspaceError,
} from "./paths.ts";

export type FileContent = string | Uint8Array;

export interface SiteFile {
  path: string;
  /** A string for text files, bytes for binary ones. */
  content: FileContent;
}

export interface SiteFileInfo {
  path: string;
  size: number;
  hash: string;
}

export type VersionSource = (typeof siteVersion.$inferSelect)["source"];
export type VersionInfo = typeof siteVersion.$inferSelect;

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** The client database, or a transaction on it. */
type Tx = Parameters<Parameters<TenantDb["transaction"]>[0]>[0];
type Executor = TenantDb | Tx;

interface Blob {
  hash: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function toBlob(path: string, content: FileContent): Blob {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      `${path} is ${bytes.byteLength} bytes; files are limited to ${MAX_FILE_BYTES}.`,
    );
  }
  // Bytes are kept as text only when they really are UTF-8, so nothing is ever mangled.
  let text: string | null = typeof content === "string" ? content : null;
  if (text === null && isTextPath(path)) {
    try {
      text = strictUtf8.decode(bytes);
    } catch {
      text = null;
    }
  }
  const encoding = text === null ? "base64" : "utf8";
  // The encoding is part of the key: the same bytes read back as a string or as bytes.
  const hash = createHash("sha256").update(`${encoding}:`).update(bytes).digest("hex");
  return {
    hash,
    encoding,
    content: text ?? bytes.toString("base64"),
    size: bytes.byteLength,
  };
}

function fromBlob(blob: Pick<Blob, "encoding" | "content">): FileContent {
  return blob.encoding === "utf8"
    ? blob.content
    : new Uint8Array(Buffer.from(blob.content, "base64"));
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/** Rows per statement, well inside SQLite's bound-parameter limit. */
const CHUNK = 200;
const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, (i + 1) * CHUNK),
  );

/** Blob statements also stay under this many characters, so a remote request stays small. */
const BLOB_BATCH_CHARS = 8 * 1024 * 1024;
function blobBatches(blobs: Blob[]): Blob[][] {
  const batches: Blob[][] = [];
  let batch: Blob[] = [];
  let chars = 0;
  for (const blob of blobs) {
    if (
      batch.length > 0 &&
      (chars + blob.content.length > BLOB_BATCH_CHARS || batch.length >= CHUNK)
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(blob);
    chars += blob.content.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const WRITE_RETRIES = 6;
const isBusy = (error: unknown) =>
  /SQLITE_BUSY|database is locked/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ""}`);

const isUniqueViolation = (error: unknown) =>
  /UNIQUE constraint failed/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ""}`);

/**
 * One site's source in the client's database: a working tree the agent edits (the draft) and
 * numbered versions saved from it. Every path goes through `normalizeSitePath`. The caller has
 * already resolved the client from the session and opened that client's database; `siteId`
 * must be a site of that client (checked against the control database by the caller).
 *
 * Changes that must not interleave (saving, restoring) run in one write transaction that takes
 * the database's write lock first, so two saves at once can't both claim the next number.
 */
export class SiteWorkspace {
  readonly db: TenantDb;
  readonly siteId: string;
  private readonly now: () => Date;

  constructor(db: TenantDb, siteId: string, options: { now?: () => Date } = {}) {
    this.db = db;
    this.siteId = siteId;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs `work` in a transaction holding the write lock from its first statement. Another
   * writer holding the lock (SQLITE_BUSY) is waited out with a short backoff.
   */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(work, { behavior: "immediate" });
      } catch (error) {
        if (!isBusy(error) || attempt >= WRITE_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
      }
    }
  }

  /** The draft's files, sorted by path. */
  listFiles(q: Executor = this.db): Promise<SiteFileInfo[]> {
    return q
      .select({ path: siteDraftFile.path, hash: siteBlob.hash, size: siteBlob.size })
      .from(siteDraftFile)
      .innerJoin(siteBlob, eq(siteBlob.hash, siteDraftFile.blobHash))
      .where(eq(siteDraftFile.siteId, this.siteId))
      .orderBy(siteDraftFile.path);
  }

  /** One draft file, or null when it doesn't exist. */
  async readFile(path: string): Promise<FileContent | null> {
    const clean = normalizeSitePath(path);
    const [row] = await this.db
      .select({ encoding: siteBlob.encoding, content: siteBlob.content })
      .from(siteDraftFile)
      .innerJoin(siteBlob, eq(siteBlob.hash, siteDraftFile.blobHash))
      .where(and(eq(siteDraftFile.siteId, this.siteId), eq(siteDraftFile.path, clean)));
    return row ? fromBlob(row) : null;
  }

  /** Writes files into the draft, creating or replacing each. */
  async writeFiles(files: SiteFile[]): Promise<void> {
    if (files.length === 0) return;
    const byPath = new Map<string, Blob>();
    for (const file of files) {
      const path = normalizeSitePath(file.path);
      byPath.set(path, toBlob(path, file.content));
    }
    const blobs = [...new Map([...byPath.values()].map((b) => [b.hash, b])).values()];
    await this.write(async (tx) => {
      const existing = new Set((await this.listFiles(tx)).map((f) => f.path));
      const added = [...byPath.keys()].filter((p) => !existing.has(p)).length;
      if (existing.size + added > MAX_FILES) {
        throw new WorkspaceError(`A site can have at most ${MAX_FILES} files.`);
      }
      for (const batch of blobBatches(blobs)) {
        await tx.insert(siteBlob).values(batch).onConflictDoNothing();
      }
      const rows = [...byPath].map(([path, blob]) => ({
        siteId: this.siteId,
        path,
        blobHash: blob.hash,
      }));
      for (const batch of chunks(rows)) {
        await tx
          .insert(siteDraftFile)
          .values(batch)
          .onConflictDoUpdate({
            target: [siteDraftFile.siteId, siteDraftFile.path],
            set: { blobHash: sqlExcluded("blob_hash") },
          });
      }
    });
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    await this.writeFiles([{ path, content }]);
  }

  /**
   * Replaces `find` with `replace` in a text file. `find` must occur exactly once unless `all`
   * is set, so an edit can't land somewhere the agent didn't mean. Returns the replacements made.
   */
  async editFile(
    path: string,
    find: string,
    replace: string,
    options: { all?: boolean } = {},
  ): Promise<number> {
    const current = await this.readFile(path);
    if (current === null) throw new WorkspaceError(`${path} doesn't exist. Write it instead.`);
    if (typeof current !== "string") throw new WorkspaceError(`${path} isn't a text file.`);
    if (find === "") throw new WorkspaceError("The text to find can't be empty.");
    const count = current.split(find).length - 1;
    if (count === 0) {
      throw new WorkspaceError(`The text to find isn't in ${path}. Read the file and try again.`);
    }
    if (count > 1 && !options.all) {
      throw new WorkspaceError(
        `The text to find occurs ${count} times in ${path}. Include more context, or set all.`,
      );
    }
    await this.writeFile(path, current.split(find).join(replace));
    return count;
  }

  /** Removes files from the draft. Missing files are ignored. */
  async deleteFiles(paths: string[]): Promise<void> {
    const clean = [...new Set(paths.map(normalizeSitePath))];
    await this.write(async (tx) => {
      for (const batch of chunks(clean)) {
        await tx
          .delete(siteDraftFile)
          .where(and(eq(siteDraftFile.siteId, this.siteId), inArray(siteDraftFile.path, batch)));
      }
    });
  }

  /** Every draft file with its content, for the sandbox or a commit. */
  async snapshot(): Promise<SiteFile[]> {
    const rows = await this.db
      .select({ path: siteDraftFile.path, encoding: siteBlob.encoding, content: siteBlob.content })
      .from(siteDraftFile)
      .innerJoin(siteBlob, eq(siteBlob.hash, siteDraftFile.blobHash))
      .where(eq(siteDraftFile.siteId, this.siteId))
      .orderBy(siteDraftFile.path);
    return rows.map((r) => ({ path: r.path, content: fromBlob(r) }));
  }

  /** The site's versions, newest first. */
  listVersions(): Promise<VersionInfo[]> {
    return this.db
      .select()
      .from(siteVersion)
      .where(eq(siteVersion.siteId, this.siteId))
      .orderBy(desc(siteVersion.number));
  }

  async latestVersion(q: Executor = this.db): Promise<VersionInfo | null> {
    const [row] = await q
      .select()
      .from(siteVersion)
      .where(eq(siteVersion.siteId, this.siteId))
      .orderBy(desc(siteVersion.number))
      .limit(1);
    return row ?? null;
  }

  async getVersion(versionId: string, q: Executor = this.db): Promise<VersionInfo> {
    const [row] = await q
      .select()
      .from(siteVersion)
      .where(and(eq(siteVersion.id, versionId), eq(siteVersion.siteId, this.siteId)));
    if (!row) throw new WorkspaceError("That version isn't one of this site's.");
    return row;
  }

  /** A saved version's files with their content. */
  async versionFiles(versionId: string): Promise<SiteFile[]> {
    await this.getVersion(versionId);
    const rows = await this.db
      .select({
        path: siteVersionFile.path,
        encoding: siteBlob.encoding,
        content: siteBlob.content,
      })
      .from(siteVersionFile)
      .innerJoin(siteBlob, eq(siteBlob.hash, siteVersionFile.blobHash))
      .where(eq(siteVersionFile.versionId, versionId))
      .orderBy(siteVersionFile.path);
    return rows.map((r) => ({ path: r.path, content: fromBlob(r) }));
  }

  private async diff(q: Executor, base: VersionInfo | null): Promise<FileChanges> {
    const before = new Map<string, string>();
    if (base) {
      const rows = await q
        .select({ path: siteVersionFile.path, hash: siteVersionFile.blobHash })
        .from(siteVersionFile)
        .where(eq(siteVersionFile.versionId, base.id));
      for (const row of rows) before.set(row.path, row.hash);
    }
    const after = new Map((await this.listFiles(q)).map((f) => [f.path, f.hash]));
    const changes: FileChanges = { added: [], modified: [], deleted: [] };
    for (const [path, hash] of after) {
      const was = before.get(path);
      if (was === undefined) changes.added.push(path);
      else if (was !== hash) changes.modified.push(path);
    }
    for (const path of before.keys()) if (!after.has(path)) changes.deleted.push(path);
    return changes;
  }

  /** How the draft differs from a version (the latest when none is given). */
  async changes(versionId?: string): Promise<FileChanges> {
    const base = versionId ? await this.getVersion(versionId) : await this.latestVersion();
    return this.diff(this.db, base);
  }

  /** Saves the draft as the next version inside `tx`; null when nothing changed. */
  async saveVersionIn(
    tx: Tx,
    input: { message: string; source: VersionSource; userId?: string | null },
  ): Promise<VersionInfo | null> {
    const latest = await this.latestVersion(tx);
    if (latest) {
      const { added, modified, deleted } = await this.diff(tx, latest);
      if (added.length + modified.length + deleted.length === 0) return null;
    }
    const files = await this.listFiles(tx);
    if (files.length === 0) throw new WorkspaceError("There's nothing to save: the site is empty.");
    const row: VersionInfo = {
      id: randomUUID(),
      siteId: this.siteId,
      number: (latest?.number ?? 0) + 1,
      message: input.message.trim().slice(0, 500) || "Saved changes",
      source: input.source,
      parentId: latest?.id ?? null,
      bookmarked: false,
      commitSha: null,
      createdByUserId: input.userId ?? null,
      createdAt: this.now(),
    };
    await tx.insert(siteVersion).values(row);
    const rows = files.map((f) => ({ versionId: row.id, path: f.path, blobHash: f.hash }));
    for (const batch of chunks(rows)) await tx.insert(siteVersionFile).values(batch);
    return row;
  }

  /**
   * Saves the draft as the next version. Returns null when nothing changed since the latest
   * version, so repeated saves don't pile up identical versions.
   */
  async saveVersion(input: {
    message: string;
    source: VersionSource;
    userId?: string | null;
  }): Promise<VersionInfo | null> {
    try {
      return await this.write((tx) => this.saveVersionIn(tx, input));
    } catch (error) {
      // Another writer took the number (a database without a write lock): try once more.
      if (!isUniqueViolation(error)) throw error;
      return this.write((tx) => this.saveVersionIn(tx, input));
    }
  }

  private async replaceDraft(tx: Tx, versionId: string): Promise<void> {
    const rows = await tx
      .select({ path: siteVersionFile.path, blobHash: siteVersionFile.blobHash })
      .from(siteVersionFile)
      .where(eq(siteVersionFile.versionId, versionId));
    await tx.delete(siteDraftFile).where(eq(siteDraftFile.siteId, this.siteId));
    const draft = rows.map((r) => ({ siteId: this.siteId, ...r }));
    for (const batch of chunks(draft)) await tx.insert(siteDraftFile).values(batch);
  }

  /**
   * Makes a version's files the draft again and saves that as a new version, so restoring is
   * itself undoable and history only ever grows. All in one transaction.
   */
  async restoreVersion(
    versionId: string,
    input: { userId?: string | null } = {},
  ): Promise<VersionInfo> {
    return (await this.restoreKeeping(versionId, { ...input, keep: false })).version;
  }

  /**
   * `restoreVersion`, first saving unsaved draft changes as their own version when `keep` is
   * set (`kept`, or null when there were none), in the same transaction so no draft write can
   * land between the two and be lost.
   */
  async restoreKeeping(
    versionId: string,
    input: { userId?: string | null; keep?: boolean } = {},
  ): Promise<{ version: VersionInfo; kept: VersionInfo | null }> {
    return this.write(async (tx) => {
      const target = await this.getVersion(versionId, tx);
      const kept =
        input.keep === false
          ? null
          : await this.saveVersionIn(tx, {
              message: `Unsaved changes, kept before restoring version ${target.number}`,
              source: "restore",
              userId: input.userId ?? null,
            });
      await this.replaceDraft(tx, target.id);
      const saved = await this.saveVersionIn(tx, {
        message: `Restored version ${target.number}`,
        source: "restore",
        userId: input.userId ?? null,
      });
      // Restoring the latest version changes nothing: it is still the current one.
      return { version: saved ?? target, kept };
    });
  }

  /** Throws away unsaved draft changes, back to the latest version. */
  async discardDraft(): Promise<void> {
    await this.write(async (tx) => {
      const latest = await this.latestVersion(tx);
      if (latest) await this.replaceDraft(tx, latest.id);
      else await tx.delete(siteDraftFile).where(eq(siteDraftFile.siteId, this.siteId));
    });
  }

  async setBookmark(versionId: string, bookmarked: boolean): Promise<void> {
    await this.getVersion(versionId);
    await this.db.update(siteVersion).set({ bookmarked }).where(eq(siteVersion.id, versionId));
  }

  /** Records the commit a version was pushed as. */
  async setCommitSha(versionId: string, commitSha: string): Promise<void> {
    await this.getVersion(versionId);
    await this.db.update(siteVersion).set({ commitSha }).where(eq(siteVersion.id, versionId));
  }
}
