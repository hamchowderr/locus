import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";

/** A new database that starts as a copy of another, optionally as it was at `at`. */
export interface DatabaseFork {
  from: string;
  /** A recent moment to copy from (Turso keeps 24 hours on the free plan). Now if omitted. */
  at?: Date;
}

/**
 * Creates, grants access to and deletes databases: one per client, and one per app-style site
 * (`siteDbName`). Both kinds live in the same Turso organisation and group, on Otaku's account.
 */
export interface TenantProvisioner {
  /** Creates the client's database. `hostname` is whatever the backend reports — never construct it. */
  create(locationId: string): Promise<{ dbName: string; hostname: string }>;
  /**
   * Creates a database by name, e.g. a site's, empty or as a fork. It can fork any database in
   * the group, so callers resolve `fork.from` from a row the session is authorized for.
   */
  createDatabase(name: string, opts?: { fork?: DatabaseFork }): Promise<CreatedDatabase>;
  /** A token that can name only this database. */
  mintToken(dbName: string, opts: { readOnly?: boolean; ttl: string }): Promise<string>;
  /** The database if it exists, e.g. one a failed attempt created but never registered. */
  findDatabase(dbName: string): Promise<CreatedDatabase | null>;
  /** Makes every token minted for this database so far stop working; other databases keep theirs. */
  revokeTokens(dbName: string): Promise<void>;
  destroy(dbName: string): Promise<void>;
  /** The libSQL URL for a database's hostname. */
  url(hostname: string): string;
}

export interface CreatedDatabase {
  dbName: string;
  hostname: string;
}

const DB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Turso's database naming rules: lowercase letters, digits and dashes, at most 64 characters. */
export function tenantDbName(locationId: string): string {
  const name = `loc-${locationId.toLowerCase()}`;
  if (!DB_NAME.test(name)) throw new Error(`Cannot derive a database name from "${locationId}"`);
  return name;
}

/** The database of an app-style site. Sites have UUIDs, so the name always fits. */
export function siteDbName(siteId: string): string {
  const name = `site-${siteId.toLowerCase()}`;
  if (!DB_NAME.test(name)) throw new Error(`Cannot derive a database name from "${siteId}"`);
  return name;
}

const LOCAL_SUFFIX = ".local";

/**
 * Local development: one SQLite file per client under `dir`, a fake hostname, a dummy token.
 *
 * It does NOT isolate anything — a file has no notion of a token. A test that claims to
 * prove a tenancy boundary must run against Turso.
 */
export class LocalProvisioner implements TenantProvisioner {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  create(locationId: string) {
    return this.createDatabase(tenantDbName(locationId));
  }

  /** A fork copies the file as it is now: a file keeps no history, so `at` is ignored. */
  async createDatabase(dbName: string, opts: { fork?: DatabaseFork } = {}) {
    const file = this.file(dbName);
    await mkdir(this.dir, { recursive: true });
    if (opts.fork) await copyFile(this.file(opts.fork.from), file);
    const client = createClient({ url: this.url(`${dbName}${LOCAL_SUFFIX}`) });
    try {
      await client.execute("select 1");
    } finally {
      client.close();
    }
    return { dbName, hostname: `${dbName}${LOCAL_SUFFIX}` };
  }

  async mintToken(dbName: string) {
    this.file(dbName);
    return "local-token-guards-nothing";
  }

  /** Local tokens guard nothing, so there is nothing to revoke. */
  async revokeTokens(dbName: string) {
    this.file(dbName);
  }

  async findDatabase(dbName: string) {
    try {
      await access(this.file(dbName));
    } catch {
      return null;
    }
    return { dbName, hostname: `${dbName}${LOCAL_SUFFIX}` };
  }

  async destroy(dbName: string) {
    const file = this.file(dbName);
    await rm(file, { force: true });
    await rm(`${file}-journal`, { force: true });
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
  }

  url(hostname: string) {
    if (!hostname.endsWith(LOCAL_SUFFIX)) throw new Error(`Not a local hostname: ${hostname}`);
    return `file:${this.file(hostname.slice(0, -LOCAL_SUFFIX.length))}`;
  }

  private file(dbName: string) {
    if (!DB_NAME.test(dbName)) throw new Error(`Invalid database name: ${dbName}`);
    return join(this.dir, `${dbName}.db`);
  }
}
