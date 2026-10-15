// Typechecks with Locus's strictest settings (`exactOptionalPropertyTypes`,
// `noUncheckedIndexedAccess`), which tsconfig.json turns off for apps/web only because the chat
// kit's installed files don't pass them (locus-8c0.18). Errors in those files are ignored here;
// any error in Locus's own code fails.
//   pnpm --filter @locus/web typecheck
import { spawnSync } from "node:child_process";

const VENDORED = [
  "components/ai-elements/",
  "components/chat/",
  "components/chat-minimal/",
  "components/ui/",
  "lib/agent-controller/",
  "lib/mastra-proxy.ts",
  "app/api/agent-controller/",
  "app/api/workspace/",
  "app/api/browser/",
  "app/api/images/",
];

const run = spawnSync(
  "tsc",
  [
    "-p",
    "tsconfig.json",
    "--exactOptionalPropertyTypes",
    "true",
    "--noUncheckedIndexedAccess",
    "true",
    "--incremental",
    "false",
  ],
  { encoding: "utf8", shell: process.platform === "win32" },
);
if (run.error) throw run.error;
// An error starts a line "path(line,col): error TSnnnn"; its detail lines are indented.
const ours = run.stdout
  .split("\n")
  .filter((line) => /^\S.*\(\d+,\d+\): error TS/.test(line))
  .filter((line) => !VENDORED.some((path) => line.startsWith(path)));
if (ours.length > 0) {
  console.error(ours.join("\n"));
  process.exit(1);
}
if (run.status !== 0 && !/error TS/.test(run.stdout)) {
  console.error(run.stdout, run.stderr);
  process.exit(run.status ?? 1);
}
