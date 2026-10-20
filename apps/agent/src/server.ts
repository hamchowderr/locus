import { serve } from "@hono/node-server";
import { createHost, hostDepsFromEnv } from "./host.ts";
import { SCRIPTED, scriptedModel } from "./scripted-model.ts";
import { settingsProblems } from "./settings-check.ts";

// One process serves every agency: a stray rejection is logged, never allowed to stop it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const deps = hostDepsFromEnv();
if (deps.model === SCRIPTED) {
  deps.model = await scriptedModel();
  console.info("Locus agent is using the scripted model: fixed replies, no AI provider");
}
const host = createHost(deps);
const port = Number(process.env.PORT ?? 3000);
// Node ends a request after five minutes by default; a member's 500 MB video on a slow line
// takes longer. Headers still have to arrive within Node's own minute.
serve({ fetch: host.fetch, port, serverOptions: { requestTimeout: 60 * 60_000 } }, () => {
  console.info(`Locus agent listening on ${port}`);
});

// A bad setting shows in the deployment's log straight away, not on someone's first message.
const problems = await settingsProblems({
  env: process.env,
  db: deps.db,
  provisioner: deps.connect.provisioner,
});
for (const problem of problems) console.error(`Locus agent is not configured: ${problem}`);
if (problems.length === 0) console.info("Locus agent settings check passed");
