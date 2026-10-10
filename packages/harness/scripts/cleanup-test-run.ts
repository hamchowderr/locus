/**
 * Deletes everything a test-write run created in a real GHL account.
 *
 *   node packages/harness/scripts/cleanup-test-run.ts <run-id>          dry run: list what is live
 *   node packages/harness/scripts/cleanup-test-run.ts <run-id> --delete delete it, newest first
 *
 * Reads the run's ledger from `.locus-test-runs/<run-id>.jsonl` and needs GHL_API_KEY and
 * GHL_LOCATION_ID for the same sub-account the run wrote to. Safe to run again.
 */

import { join } from "node:path";
import { cleanupRun, fileLedger } from "../src/test-mode.ts";

const [run, flag] = process.argv.slice(2);
if (!run) {
  console.error("usage: cleanup-test-run.ts <run-id> [--delete]");
  process.exit(2);
}
const token = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
if (!token || !locationId) {
  console.error("GHL_API_KEY and GHL_LOCATION_ID must be set");
  process.exit(2);
}

const ledger = fileLedger(join(process.cwd(), ".locus-test-runs", `${run}.jsonl`));
const live = new Map<string, string>();
for (const entry of ledger.entries()) {
  if (entry.run !== run) continue;
  const key = `${entry.kind}:${entry.id}`;
  if (entry.deleted) live.delete(key);
  else live.set(key, key);
}

if (flag !== "--delete") {
  console.log(`${live.size} live record(s) in run ${run}:`);
  for (const key of [...live.keys()].reverse()) console.log(`  ${key}`);
  console.log("re-run with --delete to remove them");
  process.exit(0);
}

const report = await cleanupRun(
  { run, ledger },
  { session: { token, tokenKind: "location", locationId } },
);
console.log(
  `deleted ${report.deleted.length}, already gone ${report.alreadyGone.length}, failed ${report.failed.length}`,
);
for (const failure of report.failed)
  console.error(`  ${failure.kind} ${failure.id}: ${failure.error}`);
process.exit(report.failed.length > 0 ? 1 : 0);
