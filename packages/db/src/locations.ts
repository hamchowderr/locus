import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ControlDb } from "./client.ts";
import { location } from "./control/schema.ts";
import type { TenantProvisioner } from "./provisioner.ts";
import { migrateTenant, type TenantMigration } from "./tenant-migrations.ts";

export interface ProvisionDeps {
  control: ControlDb;
  provisioner: TenantProvisioner;
  migrations?: TenantMigration[];
}

/**
 * Registers a client and gives it a database on the current schema. Callers must already have
 * resolved `organizationId` from the session and checked the member may do this.
 */
export async function provisionLocation(
  deps: ProvisionDeps,
  input: { organizationId: string; ghlLocationId: string; name: string },
) {
  const id = randomUUID();
  const { dbName, hostname } = await deps.provisioner.create(id);
  try {
    await deps.control.insert(location).values({
      id,
      organizationId: input.organizationId,
      ghlLocationId: input.ghlLocationId,
      name: input.name,
      tursoDbName: dbName,
      tursoDbHostname: hostname,
    });
  } catch (e) {
    await deps.provisioner.destroy(dbName);
    throw e;
  }
  const report = await migrateTenant({ ...deps, locationId: id });
  if (report.error) throw new Error(`Client ${id} was created but not migrated: ${report.error}`);
  await deps.control.update(location).set({ status: "active" }).where(eq(location.id, id));
  return { id, dbName, hostname };
}

/** Deletes the client's database, then its registry row (which cascades to everything else). */
export async function offboardLocation(deps: ProvisionDeps, locationId: string) {
  const [loc] = await deps.control.select().from(location).where(eq(location.id, locationId));
  if (!loc) return;
  await deps.control
    .update(location)
    .set({ status: "offboarding" })
    .where(eq(location.id, locationId));
  await deps.provisioner.destroy(loc.tursoDbName);
  await deps.control.delete(location).where(eq(location.id, locationId));
}
