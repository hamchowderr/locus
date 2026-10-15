// Applies the control database's migrations, then brings every client's database up to date.
//   node packages/db/scripts/migrate.ts [url]
// The URL comes from the argument, else LOCUS_CONTROL_DB_URL, else (outside production) the
// local development file. Deploys run this before building (apps/web/vercel.json), so a client
// created before a tenant migration gets it on the next deploy, not only clients created after.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEV_CONTROL_DB_URL,
  migrateControlDb,
  migrateTenants,
  openControlDb,
  provisionerFromEnv,
} from "../src/index.ts";

const url =
  process.argv[2] ??
  process.env.LOCUS_CONTROL_DB_URL ??
  (process.env.NODE_ENV === "production" ? undefined : DEV_CONTROL_DB_URL);
if (!url) {
  console.error("Set LOCUS_CONTROL_DB_URL (and LOCUS_CONTROL_DB_TOKEN for Turso).");
  process.exit(1);
}
const local = url.startsWith("file:");
if (local) await mkdir(dirname(url.slice("file:".length)), { recursive: true });

const db = openControlDb(url, process.env.LOCUS_CONTROL_DB_TOKEN);
try {
  await migrateControlDb(db);
  console.log(`control database migrated: ${url}`);

  // Client databases are migrated only by deploys of reviewed code: Production, or the
  // staging branch's Preview. Other Preview builds share staging's databases and must not
  // apply a branch's unmerged migrations to its clients.
  const vercelEnv = process.env.VERCEL_ENV;
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  if (vercelEnv === "preview" && branch !== "staging") {
    console.log(`client databases skipped: preview of ${branch ?? "a branch"}, not staging`);
  } else {
    // A remote control database lists Turso clients, whatever NODE_ENV the build step has; the
    // local file lists clients in the same .data folder the app uses.
    const env = local ? process.env : { ...process.env, LOCUS_PROVISIONER: "turso" };
    const provisioner = provisionerFromEnv(".data/tenants", env);
    const reports = await migrateTenants({ control: db, provisioner });
    const failed = reports.filter((r) => r.error);
    for (const r of reports) {
      if (r.applied.length > 0) console.log(`client ${r.locationId}: applied ${r.applied.length}`);
      if (r.unknown.length > 0)
        console.warn(`client ${r.locationId}: unknown ${r.unknown.join(", ")}`);
      if (r.error) console.error(`client ${r.locationId}: ${r.error}`);
    }
    console.log(`client databases checked: ${reports.length}, failed: ${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  }
} finally {
  db.$client.close();
}
