import { createClient } from "@libsql/client";
import { eq, ne } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { ControlDb } from "./client.ts";
import { TENANT_MIGRATIONS } from "./client.ts";
import { location, locationSchemaVersion } from "./control/schema.ts";
import type { TenantProvisioner } from "./provisioner.ts";

export interface TenantMigration {
  hash: string;
  /** Statements, in order. */
  sql: string[];
}

export interface TenantMigrationReport {
  locationId: string;
  /** Hashes applied on this run, in order. */
  applied: string[];
  /** The subset of `applied` that had been skipped while a later migration was applied. */
  repaired: string[];
  /** Hashes recorded for this tenant that no migration file has — an edited or deleted file. */
  unknown: string[];
  error?: string;
}

/** The tenant migrations shipped in this package, oldest first. */
export function loadTenantMigrations(folder = TENANT_MIGRATIONS): TenantMigration[] {
  return readMigrationFiles({ migrationsFolder: folder }).map(({ hash, sql }) => ({
    hash,
    sql: sql.map((s) => s.trim()).filter((s) => s.length > 0),
  }));
}

/** What a tenant still needs, given the hashes it has. Pure, so the gap logic is testable. */
export function planTenantMigrations(migrations: TenantMigration[], appliedHashes: string[]) {
  const have = new Set(appliedHashes);
  const known = new Set(migrations.map((m) => m.hash));
  const lastApplied = migrations.findLastIndex((m) => have.has(m.hash));
  const pending = migrations.filter((m) => !have.has(m.hash));
  return {
    pending,
    gaps: migrations.filter((m, i) => i < lastApplied && !have.has(m.hash)).map((m) => m.hash),
    unknown: appliedHashes.filter((h) => !known.has(h)),
  };
}

export interface MigrateTenantsDeps {
  control: ControlDb;
  provisioner: TenantProvisioner;
  migrations?: TenantMigration[];
}

/**
 * Walks every client from our own registry — never from Turso's database list — and applies
 * whatever each is missing, including a migration skipped in the middle. Drizzle's migrator
 * only compares against the newest applied migration and would never notice that gap, which
 * is why the full applied set lives in `location_schema_version`.
 *
 * One tenant failing never stops the others: its error is recorded and reported.
 */
export async function migrateTenants(deps: MigrateTenantsDeps): Promise<TenantMigrationReport[]> {
  const rows = await deps.control
    .select({ id: location.id })
    .from(location)
    .where(ne(location.status, "offboarding"));
  const reports: TenantMigrationReport[] = [];
  for (const row of rows) reports.push(await migrateTenant({ ...deps, locationId: row.id }));
  return reports;
}

export async function migrateTenant(
  deps: MigrateTenantsDeps & { locationId: string },
): Promise<TenantMigrationReport> {
  const { control, provisioner, locationId } = deps;
  const migrations = deps.migrations ?? loadTenantMigrations();

  const [loc] = await control.select().from(location).where(eq(location.id, locationId));
  if (!loc) throw new Error(`Unknown location ${locationId}`);
  const [version] = await control
    .select()
    .from(locationSchemaVersion)
    .where(eq(locationSchemaVersion.locationId, locationId));
  const appliedHashes = version?.appliedHashes ?? [];
  const plan = planTenantMigrations(migrations, appliedHashes);

  const report: TenantMigrationReport = {
    locationId,
    applied: [],
    repaired: [],
    unknown: plan.unknown,
  };
  if (plan.pending.length === 0) {
    await record(control, locationId, appliedHashes, null);
    return report;
  }

  const authToken = await provisioner.mintToken(loc.tursoDbName, { ttl: "10m" });
  const client = createClient({ url: provisioner.url(loc.tursoDbHostname), authToken });
  const done = [...appliedHashes];
  let error: string | null = null;
  try {
    for (const migration of plan.pending) {
      // One batch per migration: all of its statements apply, or none do.
      await client.batch(migration.sql, "write");
      done.push(migration.hash);
      report.applied.push(migration.hash);
      if (plan.gaps.includes(migration.hash)) report.repaired.push(migration.hash);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    report.error = error;
  } finally {
    client.close();
  }
  await record(control, locationId, done, error);
  return report;
}

async function record(
  control: ControlDb,
  locationId: string,
  appliedHashes: string[],
  lastError: string | null,
) {
  const values = { appliedHashes, lastMigratedAt: new Date(), lastError };
  await control
    .insert(locationSchemaVersion)
    .values({ locationId, ...values })
    .onConflictDoUpdate({ target: locationSchemaVersion.locationId, set: values });
}
