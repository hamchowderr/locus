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

interface Blob {
  hash: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

function toBlob(path: string, content: FileContent): Blob {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      `${path} is ${bytes.byteLength} bytes; files are limited to ${MAX_FILE_BYTES}.`,
    );
  }
  const text = typeof content === "string" || isTextPath(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return text
    ? { hash, encoding: "utf8", content: bytes.toString("utf8"), size: bytes.byteLength }
    : { hash, encoding: "base64", content: bytes.toString("base64"), size: bytes.byteLength };
}

function fromBlob(blob: Pick<Blob, "encoding" | "content">): FileContent {
  return blob.encoding === "utf8"
    ? blob.content
    : new Uint8Array(Buffer.from(blob.content, "base64"));
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/** SQLite's limit on bound parameters is generous on libSQL, but chunk to stay well inside it. */
const CHUNK = 200;
const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, (i + 1) * CHUNK),
  );

/**
 * One site's source in the client's database: a working tree the agent edits (the draft) and
 * numbered versions saved from it. Every path goes through `normalizeSitePath`. The caller has
 * already resolved the client from the session and opened that client's database; `siteId`
 * must be a site of that client (checked against the control database by the caller).
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

  /** The draft's files, sorted by path. */
  async listFiles(): Promise<SiteFileInfo[]> {
    const rows = await this.db
      .select({ path: siteDraftFile.path, hash: siteBlob.hash, size: siteBlob.size })
      .from(siteDraftFile)
      .innerJoin(siteBlob, eq(siteBlob.hash, siteDraftFile.blobHash))
      .where(eq(siteDraftFile.siteId, this.siteId))
      .orderBy(siteDraftFile.path);
    return rows;
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
    const existing = new Set((await this.listFiles()).map((f) => f.path));
    const added = [...byPath.keys()].filter((p) => !existing.has(p)).length;
    if (existing.size + added > MAX_FILES) {
      throw new WorkspaceError(`A site can have at most ${MAX_FILES} files.`);
    }
    const blobs = [...new Map([...byPath.values()].map((b) => [b.hash, b])).values()];
    await this.db.transaction(async (tx) => {
      for (const batch of chunks(blobs)) {
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
    for (const batch of chunks(clean)) {
      await this.db
        .delete(siteDraftFile)
        .where(and(eq(siteDraftFile.siteId, this.siteId), inArray(siteDraftFile.path, batch)));
    }
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
  async listVersions(): Promise<VersionInfo[]> {
    return this.db
      .select()
      .from(siteVersion)
      .where(eq(siteVersion.siteId, this.siteId))
      .orderBy(desc(siteVersion.number));
  }

  async latestVersion(): Promise<VersionInfo | null> {
    const [row] = await this.db
      .select()
      .from(siteVersion)
      .where(eq(siteVersion.siteId, this.siteId))
      .orderBy(desc(siteVersion.number))
      .limit(1);
    return row ?? null;
  }

  async getVersion(versionId: string): Promise<VersionInfo> {
    const [row] = await this.db
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

  /** How the draft differs from a version (the latest when none is given). */
  async changes(versionId?: string): Promise<FileChanges> {
    const base = versionId ? await this.getVersion(versionId) : await this.latestVersion();
    const before = new Map<string, string>();
    if (base) {
      const rows = await this.db
        .select({ path: siteVersionFile.path, hash: siteVersionFile.blobHash })
        .from(siteVersionFile)
        .where(eq(siteVersionFile.versionId, base.id));
      for (const row of rows) before.set(row.path, row.hash);
    }
    const after = new Map((await this.listFiles()).map((f) => [f.path, f.hash]));
    const changes: FileChanges = { added: [], modified: [], deleted: [] };
    for (const [path, hash] of after) {
      const was = before.get(path);
      if (was === undefined) changes.added.push(path);
      else if (was !== hash) changes.modified.push(path);
    }
    for (const path of before.keys()) if (!after.has(path)) changes.deleted.push(path);
    return changes;
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
    const latest = await this.latestVersion();
    if (latest) {
      const { added, modified, deleted } = await this.changes(latest.id);
      if (added.length + modified.length + deleted.length === 0) return null;
    }
    const files = await this.listFiles();
    if (files.length === 0) throw new WorkspaceError("There's nothing to save: the site is empty.");
    const message = input.message.trim().slice(0, 500) || "Saved changes";
    const row: VersionInfo = {
      id: randomUUID(),
      siteId: this.siteId,
      number: (latest?.number ?? 0) + 1,
      message,
      source: input.source,
      parentId: latest?.id ?? null,
      bookmarked: false,
      commitSha: null,
      createdByUserId: input.userId ?? null,
      createdAt: this.now(),
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(siteVersion).values(row);
      const rows = files.map((f) => ({ versionId: row.id, path: f.path, blobHash: f.hash }));
      for (const batch of chunks(rows)) await tx.insert(siteVersionFile).values(batch);
    });
    return row;
  }

  /**
   * Makes a version's files the draft again and saves that as a new version, so restoring is
   * itself undoable and history only ever grows.
   */
  async restoreVersion(versionId: string, input: { userId?: string | null } = {}) {
    const target = await this.getVersion(versionId);
    const rows = await this.db
      .select({ path: siteVersionFile.path, blobHash: siteVersionFile.blobHash })
      .from(siteVersionFile)
      .where(eq(siteVersionFile.versionId, target.id));
    await this.db.transaction(async (tx) => {
      await tx.delete(siteDraftFile).where(eq(siteDraftFile.siteId, this.siteId));
      const draft = rows.map((r) => ({ siteId: this.siteId, ...r }));
      for (const batch of chunks(draft)) await tx.insert(siteDraftFile).values(batch);
    });
    const saved = await this.saveVersion({
      message: `Restored version ${target.number}`,
      source: "restore",
      userId: input.userId ?? null,
    });
    // Restoring the latest version changes nothing: it is still the current one.
    return saved ?? target;
  }

  /** Throws away unsaved draft changes, back to the latest version. */
  async discardDraft(): Promise<void> {
    const latest = await this.latestVersion();
    if (!latest) {
      await this.db.delete(siteDraftFile).where(eq(siteDraftFile.siteId, this.siteId));
      return;
    }
    const rows = await this.db
      .select({ path: siteVersionFile.path, blobHash: siteVersionFile.blobHash })
      .from(siteVersionFile)
      .where(eq(siteVersionFile.versionId, latest.id));
    await this.db.transaction(async (tx) => {
      await tx.delete(siteDraftFile).where(eq(siteDraftFile.siteId, this.siteId));
      const draft = rows.map((r) => ({ siteId: this.siteId, ...r }));
      for (const batch of chunks(draft)) await tx.insert(siteDraftFile).values(batch);
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
