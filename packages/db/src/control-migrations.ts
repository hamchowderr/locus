import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the control migrations sit in the repository, as GitHub serves its files. */
const REPO_FOLDER = "packages/db/migrations/control";

export interface DownloadMigrationsOptions {
  /** `owner/repo` on GitHub. */
  repo: string;
  /** The branch to read, usually `main`. */
  ref: string;
  fetch?: typeof fetch;
  /** Parent of the folder this writes; defaults to the system's temporary folder. */
  dir?: string;
}

/**
 * Copies a branch's control migrations (journal and SQL files) from GitHub into a new folder
 * that Drizzle's migrator can read, and returns that folder.
 *
 * A Preview build of a pull request uses this to bring the shared staging database up to
 * `main` — what has been merged — without applying the pull request's own, unmerged
 * migrations to it. Those changed under review (renumbered, regenerated), and each version
 * that reached the shared database broke later builds ("duplicate column") or made Drizzle
 * skip `main`'s older-dated migrations.
 */
export async function downloadControlMigrations(opts: DownloadMigrationsOptions): Promise<string> {
  const get = opts.fetch ?? fetch;
  const base = `https://raw.githubusercontent.com/${opts.repo}/${opts.ref}/${REPO_FOLDER}`;
  const read = async (path: string) => {
    const res = await get(`${base}/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${path}`);
    return res.text();
  };

  const journalText = await read("meta/_journal.json");
  const journal = JSON.parse(journalText) as { entries: { tag: string }[] };
  const files = await Promise.all(
    journal.entries.map(async ({ tag }) => [tag, await read(`${tag}.sql`)] as const),
  );

  const folder = await mkdtemp(join(opts.dir ?? tmpdir(), "locus-control-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta/_journal.json"), journalText);
  for (const [tag, sql] of files) await writeFile(join(folder, `${tag}.sql`), sql);
  return folder;
}
