// Applies the control database's migrations, then brings every client's database up to date.
//   node packages/db/scripts/migrate.ts [url]
// The URL comes from the argument, else LOCUS_CONTROL_DB_URL, else (outside production) the
// local development file. Deploys run this before building (apps/web/vercel.json), so a client
// created before a tenant migration gets it on the next deploy, not only clients created after.
// A pull request's Preview brings the shared control database up to main's migrations only.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEV_CONTROL_DB_URL,
  downloadControlMigrations,
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

// Only deploys of reviewed code apply this checkout's migrations: Production, or the staging
// branch's Preview. Other Preview builds share staging's databases, so they must not apply a
// branch's unmerged migrations to them.
const vercelEnv = process.env.VERCEL_ENV;
const branch = process.env.VERCEL_GIT_COMMIT_REF;
const branchPreview = vercelEnv === "preview" && branch !== "staging";

/** How long a branch's Preview waits for the shared staging database. */
const SHARED_DB_WAIT_MS = 60_000;
let abandoned = false;

const db = openControlDb(url, process.env.LOCUS_CONTROL_DB_TOKEN);
try {
  if (branchPreview) {
    // The branch's migrations must still apply cleanly, so a broken one fails its own build.
    const scratch = openControlDb(":memory:");
    try {
      await migrateControlDb(scratch);
    } finally {
      scratch.$client.close();
    }
    console.log(`control migrations of ${branch ?? "this branch"} apply to an empty database`);

    // The shared database gets main's migrations only: what has been merged.
    const repo = `${process.env.VERCEL_GIT_REPO_OWNER ?? "hamchowderr"}/${process.env.VERCEL_GIT_REPO_SLUG ?? "locus"}`;
    let mainFolder: string | undefined;
    try {
      mainFolder = await downloadControlMigrations({ repo, ref: "main" });
    } catch (e) {
      // Not this branch's fault, so not a failed build; the next build catches up.
      console.warn(`control database skipped: main's migrations could not be read (${e})`);
    }
    if (mainFolder) {
      // A staging database that doesn't answer isn't this branch's fault either: give it a
      // minute, then build without it (main's own deploy and the next build bring it up). An
      // error it does answer with still fails the build.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        migrateControlDb(db, mainFolder).then(() => "migrated" as const),
        new Promise<"timeout">((done) => {
          timer = setTimeout(() => done("timeout"), SHARED_DB_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === "migrated") {
        console.log(`control database migrated to main: ${url}`);
      } else {
        console.warn(`control database skipped: no answer within ${SHARED_DB_WAIT_MS / 1000} s`);
        // The unanswered request would keep this process waiting; nothing else is left to do.
        abandoned = true;
      }
    }
  } else {
    await migrateControlDb(db);
    console.log(`control database migrated: ${url}`);
  }

  if (branchPreview) {
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
if (abandoned) process.exit(process.exitCode ?? 0);
