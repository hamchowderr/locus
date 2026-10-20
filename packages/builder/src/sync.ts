import { createHash } from "node:crypto";
import type { SiteRuntime } from "@locus/sandbox";
import { previewFiles, type SiteFile } from "@locus/studio";

/** sha256 of a file's bytes, as `sha256sum` prints it inside the sandbox. */
export const hashOf = (content: SiteFile["content"]) =>
  createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");

/** Folders the runtime makes itself, never part of the site's source. */
export const GENERATED_DIRS = ["node_modules", ".next", ".locus", ".git"];

/**
 * Files the sandbox makes for itself (an install writes the lockfile, `next build` writes
 * next-env.d.ts). Sync never deletes them; it still overwrites them if the draft has its own.
 */
const SANDBOX_MADE = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "next-env.d.ts"]);

export function isSandboxMade(path: string): boolean {
  return SANDBOX_MADE.has(path) || path.endsWith(".tsbuildinfo");
}

export interface SyncReport {
  written: number;
  deleted: number;
}

const LINE = /^([0-9a-f]{64}) [ *](.+)$/;

/**
 * What the sandbox holds right now: path → sha256, read with one `find … sha256sum` inside it.
 * With `paths`, only those files (missing ones are simply absent from the result).
 *
 * Nothing about a runtime is cached in this process: a sandbox can be recreated empty behind
 * the same `SiteRuntime`, another process can sync it, and a command can change its files, so
 * every sync asks the sandbox itself.
 */
export async function sandboxHashes(
  runtime: SiteRuntime,
  paths?: string[],
): Promise<Map<string, string>> {
  const listed = paths
    ? await runtime.run("sha256sum", ["--", ...paths])
    : await runtime.run("find", [
        ".",
        "-type",
        "f",
        ...GENERATED_DIRS.flatMap((dir) => ["-not", "-path", `./${dir}/*`]),
        "-exec",
        "sha256sum",
        "{}",
        "+",
      ]);
  const hashes = new Map<string, string>();
  // A partial listing (a file vanished mid-run, output cut) still names what it names; a file
  // it misses only counts as unknown, so it is written again and never deleted.
  for (const line of listed.stdout.split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const path = match[2].replace(/^\.\//, "");
    if (path) hashes.set(path, match[1]);
  }
  return hashes;
}

/**
 * Makes the runtime's project match the draft: writes what differs and deletes what the draft
 * no longer has, except the files the sandbox makes for itself (lockfiles, next-env.d.ts).
 * A recreated (empty) sandbox therefore gets every file again.
 *
 * The sandbox gets the preview's copy of the draft (`previewFiles`): pages and components carry
 * `data-locus-src` locations and the layout loads the visual-edits script, so a person can click
 * things in the preview to change them. The draft and its versions never have either.
 */
export async function syncRuntime(runtime: SiteRuntime, draft: SiteFile[]): Promise<SyncReport> {
  const files = previewFiles(draft);
  const present = await sandboxHashes(runtime);
  const wanted = new Set(files.map((f) => f.path));
  const toWrite = files.filter((f) => present.get(f.path) !== hashOf(f.content));
  const toDelete = [...present.keys()].filter((path) => !wanted.has(path) && !isSandboxMade(path));
  if (toWrite.length > 0) await runtime.writeFiles(toWrite);
  if (toDelete.length > 0) await runtime.deleteFiles(toDelete);
  return { written: toWrite.length, deleted: toDelete.length };
}
