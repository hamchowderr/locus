import { createHash } from "node:crypto";
import type { SiteRuntime } from "@locus/sandbox";
import type { SiteFile } from "@locus/studio";

const hashOf = (content: SiteFile["content"]) =>
  createHash("sha256")
    .update(
      typeof content === "string" ? `t:${content}` : Buffer.concat([Buffer.from("b:"), content]),
    )
    .digest("hex");

/** What each live runtime holds, as far as this process knows: path → content hash. */
const known = new WeakMap<SiteRuntime, Map<string, string>>();

/** Folders the runtime makes itself, never part of the site's source. */
const GENERATED = ["node_modules", ".next", ".locus", ".git"];

export interface SyncReport {
  written: number;
  deleted: number;
}

/**
 * Makes the runtime's project match the draft: writes what changed and deletes what the draft
 * no longer has. The first sync of a runtime in this process also lists the project, since a
 * persistent sandbox may still hold files from an earlier session.
 */
export async function syncRuntime(runtime: SiteRuntime, files: SiteFile[]): Promise<SyncReport> {
  let state = known.get(runtime);
  if (!state) {
    state = new Map();
    const listed = await runtime.run("find", [
      ".",
      "-type",
      "f",
      ...GENERATED.flatMap((dir) => ["-not", "-path", `./${dir}/*`]),
    ]);
    if (listed.exitCode === 0) {
      for (const line of listed.stdout.split("\n")) {
        const path = line.trim().replace(/^\.\//, "");
        // Unknown content: the hash never matches, so the file is rewritten if still wanted.
        if (path) state.set(path, "");
      }
    }
    known.set(runtime, state);
  }
  const wanted = new Map(files.map((f) => [f.path, f]));
  const toWrite = files.filter((f) => state.get(f.path) !== hashOf(f.content));
  const toDelete = [...state.keys()].filter((path) => !wanted.has(path));
  if (toWrite.length > 0) await runtime.writeFiles(toWrite);
  if (toDelete.length > 0) await runtime.deleteFiles(toDelete);
  for (const file of toWrite) state.set(file.path, hashOf(file.content));
  for (const path of toDelete) state.delete(path);
  return { written: toWrite.length, deleted: toDelete.length };
}

/** Forgets what a runtime holds, e.g. after it was recreated. */
export function forgetRuntime(runtime: SiteRuntime): void {
  known.delete(runtime);
}
