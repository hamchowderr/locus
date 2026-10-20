import { type Client, createClient, type InValue } from "@libsql/client";

// Reads an app-style site's own database for the Locus dashboard. The site's app owns its
// schema (the agent writes it through chat), so nothing here assumes a table exists: every
// table name is checked against the database's own list before it reaches SQL.

export interface SiteColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface SiteTable {
  name: string;
  columns: SiteColumn[];
  rows: number;
}

export interface SiteRows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows in the whole table, for paging. */
  total: number;
}

export interface SiteUser {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: Date | null;
}

/**
 * Opens a site's database with a token that names only it (`TenantProvisioner.mintToken`),
 * minted after the staff checks. The caller closes it.
 */
export function openSiteDb(url: string, authToken: string): Client {
  return createClient({ url, authToken });
}

/** SQLite's own tables and the migration bookkeeping, which the dashboard leaves out. */
const INTERNAL = /^(sqlite_|_litestream|__drizzle|_cf_|libsql_|_locus_)/;

const MAX_PAGE = 200;

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function tableNames(db: Client): Promise<string[]> {
  const result = await db.execute(
    "select name from sqlite_master where type = 'table' order by name",
  );
  return result.rows.map((row) => String(row.name)).filter((name) => !INTERNAL.test(name));
}

/** The site's tables with their columns and row counts. */
export async function listSiteTables(db: Client): Promise<SiteTable[]> {
  const tables: SiteTable[] = [];
  for (const name of await tableNames(db)) {
    const info = await db.execute(`pragma table_info(${quote(name)})`);
    const count = await db.execute(`select count(*) as n from ${quote(name)}`);
    tables.push({
      name,
      columns: info.rows.map((row) => ({
        name: String(row.name),
        type: String(row.type ?? ""),
        notNull: Number(row.notnull) === 1,
        primaryKey: Number(row.pk) > 0,
      })),
      rows: Number(count.rows[0]?.n ?? 0),
    });
  }
  return tables;
}

/** One page of a table, in storage order. Throws if the site has no such table. */
export async function readSiteRows(
  db: Client,
  table: string,
  page: { limit?: number; offset?: number } = {},
): Promise<SiteRows> {
  if (!(await tableNames(db)).includes(table)) throw new Error(`The site has no table ${table}.`);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), MAX_PAGE);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const args: InValue[] = [limit, offset];
  const result = await db.execute({
    sql: `select * from ${quote(table)} limit ? offset ?`,
    args,
  });
  const count = await db.execute(`select count(*) as n from ${quote(table)}`);
  return {
    columns: result.columns,
    rows: result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column) => [column, row[column]])),
    ),
    total: Number(count.rows[0]?.n ?? 0),
  };
}

/**
 * The people who signed up on the site, newest first, from Better Auth's `user` table. Empty
 * when the site has no logins yet. Never reads passwords: those live in `account`. The site
 * template names columns in snake case like Locus's own; Better Auth's camel-case defaults
 * are read too, in case a site's schema was written by hand.
 */
export async function listSiteUsers(db: Client, limit = 100): Promise<SiteUser[]> {
  if (!(await tableNames(db)).includes("user")) return [];
  const info = await db.execute(`pragma table_info("user")`);
  const columns = new Set(info.rows.map((row) => String(row.name)));
  const pick = (...names: string[]) => names.find((name) => columns.has(name));
  const id = pick("id");
  const email = pick("email");
  if (!id || !email) return [];
  const name = pick("name");
  const verified = pick("email_verified", "emailVerified");
  const created = pick("created_at", "createdAt");
  const select = [
    `${quote(id)} as id`,
    `${quote(email)} as email`,
    name ? `${quote(name)} as name` : "null as name",
    verified ? `${quote(verified)} as verified` : "0 as verified",
    created ? `${quote(created)} as created` : "null as created",
  ].join(", ");
  const result = await db.execute({
    sql: `select ${select} from "user" order by ${created ? quote(created) : "rowid"} desc limit ?`,
    args: [Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE)],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    email: String(row.email),
    emailVerified: Number(row.verified) === 1,
    createdAt: toDate(row.created),
  }));
}

// Better Auth's SQLite adapter stores dates as milliseconds; older rows may be ISO text.
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const date =
    typeof value === "string" && !/^\d+$/.test(value) ? new Date(value) : new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
