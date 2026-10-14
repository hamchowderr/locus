/** A path or file the site workspace refuses. Its message is written for the agent to fix. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Largest file the workspace keeps, decoded. Images are the large ones. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Most files one site may have. A generated Next.js site needs far fewer. */
export const MAX_FILES = 2_000;

/** Folders the tools, the build or the sandbox own (`.locus/` holds the sandbox's markers). */
const REFUSED_FOLDERS = new Set([".git", "node_modules", ".next", ".locus"]);

const SEGMENT = /^[A-Za-z0-9_@()[\]+.,=-][A-Za-z0-9_@()[\]+.,= -]*$/;

/**
 * A site-relative path, cleaned and checked: forward slashes, no leading `./` or `/`, no `..`,
 * nothing under `.git/`, `node_modules/`, `.next/` or `.locus/`, and no `.env` files — generated code is pushed to
 * the agency's repository and run in a sandbox, so it must never carry a secret.
 */
export function normalizeSitePath(input: string): string {
  if (input.includes("\0")) throw new WorkspaceError("A path can't contain a NUL character.");
  let path = input.trim().replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("/")) {
    throw new WorkspaceError(`"${input}" is absolute. Use a path relative to the site root.`);
  }
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) throw new WorkspaceError("A file path is required.");
  for (const segment of segments) {
    if (segment === "..") throw new WorkspaceError(`"${input}" leaves the site root.`);
    if (!SEGMENT.test(segment)) {
      throw new WorkspaceError(`"${segment}" in "${input}" isn't a usable file or folder name.`);
    }
  }
  for (const segment of segments.map((s) => s.toLowerCase())) {
    if (REFUSED_FOLDERS.has(segment)) {
      throw new WorkspaceError(`Files under ${segment}/ aren't part of the site's source.`);
    }
  }
  const name = (segments.at(-1) ?? "").toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || name === ".envrc" || name === ".npmrc") {
    throw new WorkspaceError(
      `Sites never contain ${name} files: they hold secrets. Read settings from process.env ` +
        "and list them in README.md.",
    );
  }
  return segments.join("/");
}

const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "md",
  "mdx",
  "html",
  "txt",
  "svg",
  "xml",
  "yml",
  "yaml",
  "toml",
  "gitignore",
  "nvmrc",
]);

/** Whether a path names a text file (stored as UTF-8) rather than a binary one (base64). */
export function isTextPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  if (!name.includes(".")) return true;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
