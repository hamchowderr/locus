import type { TenantDb } from "@locus/db";
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  type FileContent,
  type FileEntry,
  FileExistsError,
  FileNotFoundError,
  type FileStat,
  FilesystemError,
  IsDirectoryError,
  type ListOptions,
  MastraFilesystem,
  NotDirectoryError,
  type ProviderStatus,
  type ReadOptions,
  type RemoveOptions,
  StaleFileError,
  type WriteOptions,
} from "@mastra/core/workspace";
import {
  assertFolderPath,
  assertNotePath,
  BRAIN_FOLDERS,
  BrainPathError,
  INDEX_FILE,
  INSTRUCTIONS_FILE,
  isFixedFolder,
  MAX_NOTE_BYTES,
  normalizeBrainPath,
} from "./paths.ts";
import { getNote, listNotePaths, listNotes, putNote } from "./store.ts";

/** Mastra's write and walk option shapes, which its index doesn't re-export. */
type CopyOptions = { overwrite?: boolean; recursive?: boolean };
type WalkEntry = FileEntry & { path: string };

export interface BrainFilesystemOptions {
  /** Recorded on every change: `user:<id>` or `agent:<name>`. */
  actor?: string;
}

const EPOCH = new Date(0);

/**
 * One client's brain as a Mastra workspace filesystem, stored in that client's own database
 * (`brain_file`, with every change kept in `brain_file_version`). Mastra has no filesystem over
 * a database, so this is ours; agents get Mastra's file and search tools on top of it.
 *
 * Folders are not stored: the fixed folders always exist, and any other folder exists while a
 * note is inside it. `index.md` is built from the notes on every read.
 *
 * The caller opens the client's database from the session, as for sites; nothing here takes a
 * client id.
 */
export class BrainFilesystem extends MastraFilesystem {
  readonly id = "locus-brain";
  readonly name = "BrainFilesystem";
  readonly provider = "locus-brain";
  readonly displayName = "Brain";
  readonly description = "This client's notes: what the business is and how to work with it.";
  status: ProviderStatus = "pending";

  readonly #db: TenantDb;
  readonly #actor: string | null;

  constructor(db: TenantDb, options: BrainFilesystemOptions = {}) {
    super({ name: "BrainFilesystem" });
    this.#db = db;
    this.#actor = options.actor ?? null;
  }

  override async init(): Promise<void> {}

  getInstructions(): string {
    const folders = Object.entries(BRAIN_FOLDERS)
      .map(([name, purpose]) => `- ${name}/: ${purpose}`)
      .join("\n");
    return [
      "This is the client's brain: markdown notes about the business that GoHighLevel can't",
      "tell you. Never copy GoHighLevel records into it (contacts, messages, invoices); read",
      "those from GoHighLevel when you need them.",
      `${INSTRUCTIONS_FILE} says how to work with this client. ${INDEX_FILE} lists every note`,
      "with a one-line summary and is built automatically. Notes are .md files in these folders:",
      folders,
      "Keep one note per subject and start each with a `# Title` line and a one-line summary.",
    ].join("\n");
  }

  override isTextFile(): boolean {
    return true;
  }

  async readFile(input: string, options?: ReadOptions): Promise<string | Buffer> {
    await this.ensureReady();
    const path = this.#readPath(input);
    const text = await this.#readText(path);
    return options?.encoding ? text : Buffer.from(text, "utf8");
  }

  async writeFile(input: string, content: FileContent, options?: WriteOptions): Promise<void> {
    await this.ensureReady();
    const path = this.#notePath(input);
    const text = toText(path, content);
    await this.#db.transaction(async (tx) => {
      const existing = await getNote(tx, path);
      if (existing && options?.overwrite === false) throw new FileExistsError(input);
      if (existing && options?.expectedMtime && +existing.updatedAt !== +options.expectedMtime) {
        throw new StaleFileError(input, options.expectedMtime, existing.updatedAt);
      }
      if (!existing && (await this.#isDirectory(path))) throw new IsDirectoryError(input);
      if (existing?.content === text) return;
      await putNote(tx, path, text, this.#actor);
    });
  }

  async appendFile(input: string, content: FileContent): Promise<void> {
    await this.ensureReady();
    const path = this.#notePath(input);
    const existing = await getNote(this.#db, path);
    await this.writeFile(input, (existing?.content ?? "") + toText(path, content));
  }

  async deleteFile(input: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const path = this.#path(input);
    if (path === INDEX_FILE) throw refused(input, "index.md is built from the notes.");
    const existing = await getNote(this.#db, path);
    if (!existing) {
      if (await this.#isDirectory(path)) throw new IsDirectoryError(input);
      if (options?.force) return;
      throw new FileNotFoundError(input);
    }
    await putNote(this.#db, path, null, this.#actor);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.#copy(src, dest, options, false);
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.#copy(src, dest, options, true);
  }

  async mkdir(input: string): Promise<void> {
    await this.ensureReady();
    const path = this.#path(input);
    if (path === "") return;
    if (await getNote(this.#db, path)) throw new FileExistsError(input);
    try {
      assertFolderPath(path);
    } catch (e) {
      throw asFilesystemError(input, e);
    }
    // Nothing to store: a folder exists while a note is inside it.
  }

  async rmdir(input: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const path = this.#path(input);
    const inside = (await listNotePaths(this.#db)).filter((n) => isUnder(n.path, path));
    if (isFixedFolder(path)) {
      throw refused(input, "The brain's own folders can't be removed. Delete the notes instead.");
    }
    if (inside.length === 0) {
      if (await getNote(this.#db, path)) throw new NotDirectoryError(input);
      if (options?.force) return;
      throw new DirectoryNotFoundError(input);
    }
    if (!options?.recursive) throw new DirectoryNotEmptyError(input);
    await this.#db.transaction(async (tx) => {
      for (const note of inside) await putNote(tx, note.path, null, this.#actor);
    });
  }

  async readdir(input: string, options?: ListOptions): Promise<FileEntry[]> {
    await this.ensureReady();
    const path = this.#path(input);
    const entries = await this.#entries(path, options?.recursive ? options.maxDepth : 1);
    const extensions = [options?.extension ?? []].flat();
    return entries
      .filter(
        (e) =>
          e.type === "directory" ||
          extensions.length === 0 ||
          extensions.some((x) => e.name.endsWith(x.startsWith(".") ? x : `.${x}`)),
      )
      .map(({ path: relative, ...entry }) => ({
        ...entry,
        name: options?.recursive ? relative : entry.name,
      }));
  }

  async walk(input: string, options?: { maxDepth?: number }): Promise<WalkEntry[]> {
    await this.ensureReady();
    return this.#entries(this.#path(input), options?.maxDepth);
  }

  async exists(input: string): Promise<boolean> {
    await this.ensureReady();
    const path = normalizeOrNull(input);
    if (path === null) return false;
    if (path === INDEX_FILE) return true;
    return Boolean(await getNote(this.#db, path)) || (await this.#isDirectory(path));
  }

  async stat(input: string): Promise<FileStat> {
    await this.ensureReady();
    const path = this.#readPath(input);
    const name = path.split("/").at(-1) ?? "";
    const abs = `/${path}`;
    if (path === INDEX_FILE) {
      const text = await this.#readText(path);
      const now = new Date();
      const size = Buffer.byteLength(text, "utf8");
      return { name, path: abs, type: "file", size, createdAt: now, modifiedAt: now };
    }
    const note = await getNote(this.#db, path);
    if (note) {
      return {
        name,
        path: abs,
        type: "file",
        size: note.size,
        createdAt: note.createdAt,
        modifiedAt: note.updatedAt,
        mimeType: "text/markdown",
      };
    }
    if (await this.#isDirectory(path)) {
      return { name, path: abs, type: "directory", size: 0, createdAt: EPOCH, modifiedAt: EPOCH };
    }
    throw new FileNotFoundError(input);
  }

  #path(input: string): string {
    try {
      return normalizeBrainPath(input);
    } catch (e) {
      throw asFilesystemError(input, e);
    }
  }

  /** Reads of a name the brain can't hold (Mastra looks for `.gitignore`) find nothing. */
  #readPath(input: string): string {
    const path = normalizeOrNull(input);
    if (path === null) throw new FileNotFoundError(input);
    return path;
  }

  #notePath(input: string): string {
    const path = this.#path(input);
    try {
      assertNotePath(path);
    } catch (e) {
      throw asFilesystemError(input, e);
    }
    return path;
  }

  async #readText(path: string): Promise<string> {
    if (path === INDEX_FILE) return buildIndex(await listNotes(this.#db));
    const note = await getNote(this.#db, path);
    if (note) return note.content;
    if (await this.#isDirectory(path)) throw new IsDirectoryError(path);
    throw new FileNotFoundError(path);
  }

  async #isDirectory(path: string): Promise<boolean> {
    if (isFixedFolder(path)) return true;
    return (await listNotePaths(this.#db)).some((n) => isUnder(n.path, path));
  }

  /** Files and folders under `root`, paths relative to it, down to `maxDepth` (1 = children). */
  async #entries(root: string, maxDepth = Number.POSITIVE_INFINITY): Promise<WalkEntry[]> {
    const notes = await listNotePaths(this.#db);
    if (notes.some((n) => n.path === root)) throw new NotDirectoryError(root);
    if (!(await this.#isDirectory(root))) throw new DirectoryNotFoundError(root);
    const files = new Map(notes.map((n) => [n.path, n.size]));
    if (root === "") {
      files.set(INDEX_FILE, 0);
      for (const folder of Object.keys(BRAIN_FOLDERS)) files.set(`${folder}/`, -1);
    }
    const out = new Map<string, WalkEntry>();
    for (const [full, size] of files) {
      if (!isUnder(full, root)) continue;
      const relative = (root ? full.slice(root.length + 1) : full).replace(/\/$/, "");
      const parts = relative.split("/");
      // Every folder on the way down, then the file itself.
      for (let depth = 1; depth <= Math.min(parts.length, maxDepth); depth++) {
        const path = parts.slice(0, depth).join("/");
        const isFile = depth === parts.length && size >= 0;
        if (out.has(path)) continue;
        out.set(path, {
          name: parts[depth - 1] ?? "",
          path,
          type: isFile ? "file" : "directory",
          ...(isFile ? { size } : {}),
        });
      }
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async #copy(src: string, dest: string, options: CopyOptions | undefined, move: boolean) {
    await this.ensureReady();
    const from = this.#path(src);
    const to = this.#path(dest);
    if (from === INDEX_FILE) throw refused(src, "index.md is built from the notes.");
    if (move && isFixedFolder(from)) {
      throw refused(src, "The brain's own folders can't be moved. Move the notes inside them.");
    }
    const notes = await listNotePaths(this.#db);
    const pairs: [string, string][] = notes.some((n) => n.path === from)
      ? [[from, to]]
      : notes
          .filter((n) => isUnder(n.path, from))
          .map((n) => [n.path, `${to}/${n.path.slice(from.length + 1)}`]);
    if (pairs.length === 0) throw new FileNotFoundError(src);
    if (pairs[0]?.[0] !== from && !options?.recursive) throw new IsDirectoryError(src);
    for (const [, target] of pairs) {
      try {
        assertNotePath(target);
      } catch (e) {
        throw asFilesystemError(dest, e);
      }
    }
    await this.#db.transaction(async (tx) => {
      for (const [source, target] of pairs) {
        const text = (await getNote(tx, source))?.content ?? "";
        const existing = await getNote(tx, target);
        if (existing && options?.overwrite === false) throw new FileExistsError(dest);
        if (existing?.content !== text) await putNote(tx, target, text, this.#actor);
        if (move) await putNote(tx, source, null, this.#actor);
      }
    });
  }
}

function normalizeOrNull(input: string): string | null {
  try {
    return normalizeBrainPath(input);
  } catch {
    return null;
  }
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path.startsWith(`${folder}/`);
}

function toText(path: string, content: FileContent): string {
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  if (text.includes("�") && typeof content !== "string") {
    throw refused(path, "The brain holds text notes only, not binary files.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) {
    throw refused(
      path,
      `The note is over ${MAX_NOTE_BYTES / 1024} KB. Split it into smaller notes by subject.`,
    );
  }
  return text;
}

function refused(path: string, message: string): FilesystemError {
  return new FilesystemError(message, "EPERM", path);
}

function asFilesystemError(path: string, e: unknown): unknown {
  return e instanceof BrainPathError ? refused(path, e.message) : e;
}

/** A note's one-line summary: its first line that isn't a heading, frontmatter or blank. */
export function summarize(content: string): string {
  const lines = content.split("\n").map((l) => l.trim());
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    const description = lines
      .slice(1, end)
      .find((l) => l.startsWith("description:"))
      ?.slice("description:".length)
      .trim();
    if (description) return clip(description);
    i = end + 1;
  }
  const heading = lines.slice(i).find((l) => l.startsWith("#"));
  const line = lines.slice(i).find((l) => l !== "" && !l.startsWith("#"));
  return clip(line ?? heading?.replace(/^#+\s*/, "") ?? "");
}

function clip(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** `index.md`: every note with its summary, grouped by folder, so an agent knows what to open. */
export function buildIndex(notes: { path: string; content: string }[]): string {
  const lines = [
    "# Brain index",
    "",
    "Built automatically from the notes. Open a note to read it.",
    "",
  ];
  const top = notes.find((n) => n.path === INSTRUCTIONS_FILE);
  lines.push(`- ${INSTRUCTIONS_FILE}: ${top ? summarize(top.content) : "(empty)"}`);
  for (const [folder, purpose] of Object.entries(BRAIN_FOLDERS)) {
    lines.push("", `## ${folder}/`, "", purpose, "");
    const inside = notes.filter((n) => n.path.startsWith(`${folder}/`));
    if (inside.length === 0) lines.push("(no notes yet)");
    for (const note of inside) lines.push(`- ${note.path}: ${summarize(note.content)}`);
  }
  return `${lines.join("\n")}\n`;
}
