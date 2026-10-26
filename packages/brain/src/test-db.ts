import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTenantDb, TENANT_MIGRATION_SET, type TenantDb } from "@locus/db";

/** A fresh client database on the current tenant schema, in a temp folder. */
export async function tenantDbForTest(): Promise<{ db: TenantDb; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "locus-brain-"));
  const db = openTenantDb(`file:${join(dir, "tenant.db")}`);
  for (const migration of TENANT_MIGRATION_SET) {
    for (const statement of migration.sql) await db.$client.execute(statement);
  }
  return {
    db,
    close: async () => {
      db.$client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
