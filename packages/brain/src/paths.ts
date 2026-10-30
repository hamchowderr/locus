/**
 * The brain's fixed layout. Every client's brain looks the same, so an agent always knows where
 * to look: two files at the top, and fixed folders that notes go into.
 */
export const INSTRUCTIONS_FILE = "instructions.md";
/** Built from the notes on every read, never stored. */
export const INDEX_FILE = "index.md";

export const BRAIN_FOLDERS = {
  business: "Offers and pricing, hours and service area, brand voice, FAQs, policies.",
  people: "The client's staff and their roles. Never customers or contacts.",
  playbooks: "How recurring jobs are done for this client.",
  work: "One note per site, funnel or campaign built or run, with where to find it.",
  decisions: "Dated decisions and the reason for each.",
  sources: "Summaries of files the client gave us or pages of their website.",
  inbox: "Rough notes a person hasn't sorted into a folder yet.",
} as const;
export type BrainFolder = keyof typeof BRAIN_FOLDERS;

/**
 * The note Locus writes when an agency picks its main sub-account: how it is set up in
 * GoHighLevel. A brain holding only this is still new to the agent.
 */
export const SETUP_NOTE = "business/gohighlevel-setup.md";

/** Largest note kept, in UTF-8 bytes. Far more than a note needs; it keeps a prompt affordable. */
export const MAX_NOTE_BYTES = 256 * 1024;

/** A path the brain refuses. Its message is written for the agent to fix. */
export class BrainPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainPathError";
  }
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_ .,()&+-]*$/;

/**
 * A path inside the brain, cleaned: forward slashes, no leading `/` or `./`, no `..`. The root
 * is `""`. Mastra's tools pass absolute paths (`/business/pricing.md`); they mean the same.
 */
export function normalizeBrainPath(input: string): string {
  if (input.includes("\0")) throw new BrainPathError("A path can't contain a NUL character.");
  const segments = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  for (const segment of segments) {
    if (segment === "..") throw new BrainPathError(`"${input}" leaves the brain.`);
    if (!SEGMENT.test(segment)) {
      throw new BrainPathError(`"${segment}" in "${input}" isn't a usable file or folder name.`);
    }
  }
  return segments.join("/");
}

function isFolder(name: string): name is BrainFolder {
  return Object.hasOwn(BRAIN_FOLDERS, name);
}

/**
 * Checks a normalized path can hold a note: `instructions.md` at the top, or a `.md` file inside
 * one of the fixed folders. `index.md` is built from the notes and can't be written.
 */
export function assertNotePath(path: string): void {
  if (path === INDEX_FILE) {
    throw new BrainPathError(
      "index.md is built from the notes automatically. Change the notes instead.",
    );
  }
  if (!path.toLowerCase().endsWith(".md")) {
    throw new BrainPathError(`"${path}" isn't a .md file. The brain holds markdown notes only.`);
  }
  if (path === INSTRUCTIONS_FILE) return;
  const [top, ...rest] = path.split("/");
  if (rest.length === 0 || !top || !isFolder(top)) {
    throw new BrainPathError(
      `"${path}" isn't inside a brain folder. Notes go in one of: ${Object.keys(BRAIN_FOLDERS)
        .map((f) => `${f}/`)
        .join(", ")}.`,
    );
  }
}

/** Checks a normalized path can be a folder: one of the fixed folders or a folder inside one. */
export function assertFolderPath(path: string): void {
  const top = path.split("/")[0] ?? "";
  if (!isFolder(top)) {
    throw new BrainPathError(
      `"${path}" isn't a brain folder. New folders go inside one of: ${Object.keys(BRAIN_FOLDERS)
        .map((f) => `${f}/`)
        .join(", ")}.`,
    );
  }
}

/** Whether a normalized path is the root or one of the fixed folders, which always exist. */
export function isFixedFolder(path: string): boolean {
  return path === "" || isFolder(path);
}
