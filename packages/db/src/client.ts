import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as controlSchema from "./control/index.ts";
import type * as tenantSchema from "./tenant/index.ts";

export type ControlDb = LibSQLDatabase<typeof controlSchema> & { $client: Client };
export type TenantDb = LibSQLDatabase<typeof tenantSchema> & { $client: Client };

export const CONTROL_MIGRATIONS = fileURLToPath(new URL("../migrations/control", import.meta.url));
export const TENANT_MIGRATIONS = fileURLToPath(new URL("../migrations/tenant", import.meta.url));

/** Opens the control database, e.g. `file:./.data/control.db` locally. */
export function openControlDb(url: string, authToken?: string): ControlDb {
  const client = createClient(authToken === undefined ? { url } : { url, authToken });
  return drizzle(client, { schema: controlSchema });
}

/** The control database is one database, so Drizzle's own migrator is enough for it. */
export async function migrateControlDb(db: ControlDb): Promise<void> {
  await migrate(db, { migrationsFolder: CONTROL_MIGRATIONS });
}
