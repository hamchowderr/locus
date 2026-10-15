import { createClient } from "@libsql/client";
import { eq, ne } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { ControlDb } from "./client.ts";
import { TENANT_MIGRATIONS } from "./client.ts";
import { location, locationSchemaVersion } from "./control/schema.ts";
import { EMBEDDED_TENANT_MIGRATIONS } from "./generated/tenant-migrations.ts";
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

/**
 * The tenant migrations, embedded in code by `scripts/embed-migrations.ts`: the deployed app
 * migrates a new client at run time and has no migrations folder to read.
 */
export const TENANT_MIGRATION_SET: TenantMigration[] = EMBEDDED_TENANT_MIGRATIONS;

/** Reads the tenant migrations from the folder, oldest first. Tests and the embed script only. */
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
  const migrations = deps.migrations ?? TENANT_MIGRATION_SET;

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
  // Nothing to apply: leave the hashes alone, so a build with an older migration set can't
  // overwrite what a newer one recorded meanwhile. Only an old error is cleared.
  if (plan.pending.length === 0) {
    if (version?.lastError) {
      await control
        .update(locationSchemaVersion)
        .set({ lastError: null, lastMigratedAt: new Date() })
        .where(eq(locationSchemaVersion.locationId, locationId));
    }
    return report;
  }

  const done: string[] = [];
  let error: string | null = null;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    // Inside the try: a Turso API failure is this tenant's error, not the end of the run.
    const authToken = await provisioner.mintToken(loc.tursoDbName, { ttl: "10m" });
    client = createClient({ url: provisioner.url(loc.tursoDbHostname), authToken });
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
    client?.close();
  }
  const covered = await record(control, locationId, done, error, migrations);
  // Another deploy applied the same migrations while this one ran (the batch then fails on
  // "already exists"): the client is up to date, so this is not a failure.
  if (covered) delete report.error;
  return report;
}

/**
 * Adds `applied` to the tenant's recorded hashes. It re-reads them in the same transaction
 * rather than writing back the list read before migrating, so two deploys migrating at once
 * never erase each other's record.
 */
async function record(
  control: ControlDb,
  locationId: string,
  applied: string[],
  error: string | null,
  migrations: TenantMigration[],
): Promise<boolean> {
  return control.transaction(async (tx) => {
    const [current] = await tx
      .select({ appliedHashes: locationSchemaVersion.appliedHashes })
      .from(locationSchemaVersion)
      .where(eq(locationSchemaVersion.locationId, locationId));
    const have = current?.appliedHashes ?? [];
    const appliedHashes = [...have, ...applied.filter((h) => !have.includes(h))];
    const covered = migrations.every((m) => appliedHashes.includes(m.hash));
    const values = { appliedHashes, lastMigratedAt: new Date(), lastError: covered ? null : error };
    await tx
      .insert(locationSchemaVersion)
      .values({ locationId, ...values })
      .onConflictDoUpdate({ target: locationSchemaVersion.locationId, set: values });
    return covered;
  });
}
