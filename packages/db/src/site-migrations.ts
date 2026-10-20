import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

// Schema changes for an app-style site's own database. They live in the site's source, under
// `db/migrations/`, as numbered SQL files the agent writes through chat. The site applies them
// to its local database while it runs in the sandbox; Locus applies them to the site's Turso
// database when the site is published. Both keep the same ledger, so a migration runs once.

export const SITE_MIGRATIONS_DIR = "db/migrations";
export const SITE_MIGRATIONS_TABLE = "_locus_migrations";
/** Separates statements in one file, as drizzle-kit writes them. */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** The env vars a published site reads; Locus sets them on its host, never in the repo. */
export const SITE_DATABASE_ENV = {
  url: "SITE_DATABASE_URL",
  token: "SITE_DATABASE_TOKEN",
  /** The site's own login secret: one per site, never Locus's own `BETTER_AUTH_SECRET`. */
  authSecret: "SITE_AUTH_SECRET",
  /** Proves the site's routes are the site when they ask Locus for its files. */
  filesKey: "SITE_FILES_KEY",
} as const;

/**
 * The largest file a site's member may upload. A file passes through the site's own route and
 * Locus's on its way to the client's Media Library, and a Vercel function takes at most 4.5 MB
 * in one request.
 */
export const MAX_SITE_FILE_BYTES = 4 * 1024 * 1024;

/** What a site's members may upload: pictures and everyday documents. Never HTML or SVG. */
export const SITE_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** Videos a site's member may upload: only the way that bypasses Vercel (`MAX_SITE_VIDEO_BYTES`). */
export const SITE_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;

/**
 * The largest picture or document a member may send straight to Locus's own server (the agent
 * server, which no Vercel request limit applies to): HighLevel's own limit for a file.
 */
export const MAX_LARGE_SITE_FILE_BYTES = 25 * 1024 * 1024;
/** HighLevel's limit for a video. */
export const MAX_SITE_VIDEO_BYTES = 500 * 1024 * 1024;

const FILE = /^db\/migrations\/(\d{4}_[a-z0-9_]+)\.sql$/;

export interface SiteMigration {
  /** e.g. `0001_bookings`. */
  name: string;
  sql: string;
}

export class SiteMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteMigrationError";
  }
}

/**
 * The site's migrations, in order, from its files. Other files are ignored, and so are files in
 * folders under `db/migrations/` (such as drizzle-kit's `meta/`).
 */
export function siteMigrationsIn(
  files: { path: string; content: string | Uint8Array }[],
): SiteMigration[] {
  const migrations: SiteMigration[] = [];
  for (const file of files) {
    if (!file.path.startsWith(`${SITE_MIGRATIONS_DIR}/`)) continue;
    if (file.path.slice(SITE_MIGRATIONS_DIR.length + 1).includes("/")) continue;
    const match = FILE.exec(file.path);
    if (!match?.[1]) {
      // The path is the agent's: keep it short, since the message can reach the person.
      const path = file.path.length > 200 ? `${file.path.slice(0, 200)}…` : file.path;
      throw new SiteMigrationError(`${path} isn't named like db/migrations/0001_short_name.sql.`);
    }
    const sql =
      typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
    migrations.push({ name: match[1], sql });
  }
  migrations.sort((a, b) => a.name.localeCompare(b.name));
  const numbers = migrations.map((m) => m.name.slice(0, 4));
  const repeated = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (repeated) throw new SiteMigrationError(`Two migrations are numbered ${repeated}.`);
  return migrations;
}

/** The statements of one migration file. */
export function migrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");

const LEDGER = `create table if not exists ${SITE_MIGRATIONS_TABLE} (
  name text primary key,
  hash text not null,
  applied_at integer not null
)`;

/** The migrations not yet applied. Throws if one already applied was edited since. */
export async function pendingSiteMigrations(
  db: Client,
  migrations: SiteMigration[],
): Promise<SiteMigration[]> {
  await db.execute(LEDGER);
  const applied = new Map(
    (await db.execute(`select name, hash from ${SITE_MIGRATIONS_TABLE}`)).rows.map((row) => [
      String(row.name),
      String(row.hash),
    ]),
  );
  for (const migration of migrations) {
    const was = applied.get(migration.name);
    if (was && was !== hash(migration.sql)) {
      throw new SiteMigrationError(
        `${migration.name} was changed after it ran. Add a new migration instead of editing it.`,
      );
    }
  }
  return migrations.filter((migration) => !applied.has(migration.name));
}

/**
 * Applies the pending migrations in order. Each one runs in its own transaction with its
 * ledger row, so a failure leaves that migration (and the ones after it) unapplied and
 * everything before it in place. It runs through libSQL's `migrate`, which turns foreign keys
 * off outside the transaction: SQLite ignores `PRAGMA foreign_keys` inside one, and a table
 * rebuild (drop and rename) would otherwise cascade-delete every row that refers to it.
 */
export async function applySiteMigrations(
  db: Client,
  migrations: SiteMigration[],
  now = Date.now(),
): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  for (const migration of await pendingSiteMigrations(db, migrations)) {
    const statements: InStatement[] = migrationStatements(migration.sql);
    statements.push({
      sql: `insert into ${SITE_MIGRATIONS_TABLE} (name, hash, applied_at) values (?, ?, ?)`,
      args: [migration.name, hash(migration.sql), now],
    });
    try {
      await db.migrate(statements);
    } catch (error) {
      // Two publishes at once: the other one applied it first, so there is nothing left to do.
      if (await ranAlready(db, migration)) continue;
      // Only the database's verdict on the SQL is the migration's fault; a lost connection or
      // a refused token is not, and stays an ordinary error.
      if (!isSqlError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const short = reason.length > 600 ? `${reason.slice(0, 600)}…` : reason;
      throw new SiteMigrationError(`${migration.name} failed: ${short}`);
    }
    applied.push(migration.name);
  }
  return { applied };
}

async function ranAlready(db: Client, migration: SiteMigration): Promise<boolean> {
  const result = await db
    .execute({
      sql: `select hash from ${SITE_MIGRATIONS_TABLE} where name = ?`,
      args: [migration.name],
    })
    .catch(() => null);
  return result?.rows[0]?.hash === hash(migration.sql);
}

/** SQLite's own error codes, as libSQL reports them locally and from Turso. */
function isSqlError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_|^SQL_/.test(code);
}
