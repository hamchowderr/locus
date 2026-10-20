import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { CONTROL_MIGRATIONS, migrateControlDb, openControlDb } from "./client.ts";
import { downloadControlMigrations } from "./control-migrations.ts";

const BASE = "https://raw.githubusercontent.com/acme/locus/main/packages/db/migrations/control/";

/** Serves this checkout's control migrations as GitHub would serve main's. */
function fakeGitHub(missing?: string) {
  const urls: string[] = [];
  const get = async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const path = url.slice(BASE.length);
    if (!url.startsWith(BASE) || path === missing) return new Response("404", { status: 404 });
    return new Response(await readFile(join(CONTROL_MIGRATIONS, path), "utf8"));
  };
  return { urls, fetch: get as typeof fetch };
}

describe("downloadControlMigrations", () => {
  it("copies main's migrations into a folder the migrator reads unchanged", async () => {
    const gh = fakeGitHub();
    const folder = await downloadControlMigrations({
      repo: "acme/locus",
      ref: "main",
      fetch: gh.fetch,
    });
    expect(gh.urls[0]).toBe(`${BASE}meta/_journal.json`);

    const copied = readMigrationFiles({ migrationsFolder: folder });
    const local = readMigrationFiles({ migrationsFolder: CONTROL_MIGRATIONS });
    expect(copied.map((m) => [m.hash, m.folderMillis])).toEqual(
      local.map((m) => [m.hash, m.folderMillis]),
    );

    const db = openControlDb(":memory:");
    try {
      await migrateControlDb(db, folder);
      const rows = await db.$client.execute("select count(*) as n from __drizzle_migrations");
      expect(Number(rows.rows[0]?.n)).toBe(local.length);
    } finally {
      db.$client.close();
    }
  });

  it("fails rather than returning part of the set", async () => {
    const journal = JSON.parse(
      await readFile(join(CONTROL_MIGRATIONS, "meta/_journal.json"), "utf8"),
    );
    const missing = `${journal.entries.at(-1).tag}.sql`;
    await expect(
      downloadControlMigrations({
        repo: "acme/locus",
        ref: "main",
        fetch: fakeGitHub(missing).fetch,
      }),
    ).rejects.toThrow(`GitHub returned 404 for ${missing}`);
  });
});
