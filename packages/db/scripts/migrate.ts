// Applies the control database's migrations.
//   node packages/db/scripts/migrate.ts [url]
// The URL comes from the argument, else LOCUS_CONTROL_DB_URL, else (outside production) the
// local development file. Tenant databases are migrated by `migrateTenants`, not this.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEV_CONTROL_DB_URL, migrateControlDb, openControlDb } from "../src/index.ts";

const url =
  process.argv[2] ??
  process.env.LOCUS_CONTROL_DB_URL ??
  (process.env.NODE_ENV === "production" ? undefined : DEV_CONTROL_DB_URL);
if (!url) {
  console.error("Set LOCUS_CONTROL_DB_URL (and LOCUS_CONTROL_DB_TOKEN for Turso).");
  process.exit(1);
}
if (url.startsWith("file:")) await mkdir(dirname(url.slice("file:".length)), { recursive: true });

const db = openControlDb(url, process.env.LOCUS_CONTROL_DB_TOKEN);
await migrateControlDb(db);
db.$client.close();
console.log(`control database migrated: ${url}`);
