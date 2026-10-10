import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";

/** Creates, grants access to and deletes one client's database. */
export interface TenantProvisioner {
  /** Creates the database. `hostname` is whatever the backend reports — never construct it. */
  create(locationId: string): Promise<{ dbName: string; hostname: string }>;
  /** A token that can name only this database. */
  mintToken(dbName: string, opts: { readOnly?: boolean; ttl: string }): Promise<string>;
  destroy(dbName: string): Promise<void>;
  /** The libSQL URL for a database's hostname. */
  url(hostname: string): string;
}

const DB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Turso's database naming rules: lowercase letters, digits and dashes, at most 64 characters. */
export function tenantDbName(locationId: string): string {
  const name = `loc-${locationId.toLowerCase()}`;
  if (!DB_NAME.test(name)) throw new Error(`Cannot derive a database name from "${locationId}"`);
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

  async create(locationId: string) {
    const dbName = tenantDbName(locationId);
    await mkdir(this.dir, { recursive: true });
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
