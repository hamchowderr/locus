import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ControlDb } from "./client.ts";
import { location, siteBackend, siteBackendRestore } from "./control/schema.ts";
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
  await finishProvisioning(deps, id);
  return { id, dbName, hostname };
}

/**
 * Migrates a registered client's database and marks it active. Also resumes a client left in
 * `provisioning` by an earlier attempt that failed after its database was created.
 */
export async function finishProvisioning(deps: ProvisionDeps, locationId: string) {
  const report = await migrateTenant({ ...deps, locationId });
  if (report.error) {
    throw new Error(`Client ${locationId} was created but not migrated: ${report.error}`);
  }
  await deps.control.update(location).set({ status: "active" }).where(eq(location.id, locationId));
}

/**
 * Deletes the databases of the client's app-style sites, then the client's own database, then
 * its registry row (which cascades to everything else). Safe to repeat after a failure.
 */
export async function offboardLocation(deps: ProvisionDeps, locationId: string) {
  const [loc] = await deps.control.select().from(location).where(eq(location.id, locationId));
  if (!loc) return;
  await deps.control
    .update(location)
    .set({ status: "offboarding" })
    .where(eq(location.id, locationId));
  const backends = await deps.control
    .select()
    .from(siteBackend)
    .where(eq(siteBackend.locationId, locationId));
  // A database a site's last restore replaced (kept for undo) goes first, with its row.
  const restores = await deps.control
    .select()
    .from(siteBackendRestore)
    .where(eq(siteBackendRestore.locationId, locationId));
  for (const restore of restores) {
    for (const name of [restore.keptDbName, ...restore.retired.map((r) => r.dbName)]) {
      if (name) await deps.provisioner.destroy(name);
    }
    await deps.control
      .delete(siteBackendRestore)
      .where(eq(siteBackendRestore.siteId, restore.siteId));
  }
  for (const backend of backends) {
    await deps.provisioner.destroy(backend.tursoDbName);
    await deps.control.delete(siteBackend).where(eq(siteBackend.siteId, backend.siteId));
  }
  await deps.provisioner.destroy(loc.tursoDbName);
  await deps.control.delete(location).where(eq(location.id, locationId));
}
