import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as controlSchema from "./control/index.ts";
import * as tenantSchema from "./tenant/index.ts";

export type ControlDb = LibSQLDatabase<typeof controlSchema> & { $client: Client };
export type TenantDb = LibSQLDatabase<typeof tenantSchema> & { $client: Client };

// Built from the module's own path rather than `new URL("../migrations/…", import.meta.url)`:
// bundlers (Next.js) treat that pattern as an asset to bundle, and a folder is not one.
const here = dirname(fileURLToPath(import.meta.url));
export const CONTROL_MIGRATIONS = join(here, "../migrations/control");
export const TENANT_MIGRATIONS = join(here, "../migrations/tenant");

/** Local development's control database, relative to the app's working directory. */
export const DEV_CONTROL_DB_URL = "file:.data/control.db";

/** Opens the control database, e.g. `file:./.data/control.db` locally. */
export function openControlDb(url: string, authToken?: string): ControlDb {
  const client = createClient(authToken === undefined ? { url } : { url, authToken });
  return drizzle(client, { schema: controlSchema });
}

/**
 * Opens one client's database. The caller supplies a token that names only that database
 * (`TenantProvisioner.mintToken`), minted after the staff checks — never a group token.
 */
export function openTenantDb(url: string, authToken?: string): TenantDb {
  const client = createClient(authToken === undefined ? { url } : { url, authToken });
  return drizzle(client, { schema: tenantSchema });
}

/** The control database is one database, so Drizzle's own migrator is enough for it. */
export async function migrateControlDb(db: ControlDb): Promise<void> {
  await migrate(db, { migrationsFolder: CONTROL_MIGRATIONS });
}
