import { serve } from "@hono/node-server";
import { createHost, hostDepsFromEnv } from "./host.ts";
import { SCRIPTED, scriptedModel } from "./scripted-model.ts";

// One process serves every agency: a stray rejection is logged, never allowed to stop it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const deps = hostDepsFromEnv();
if (deps.model === SCRIPTED) deps.model = await scriptedModel();
const host = createHost(deps);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: host.fetch, port }, () => {
  console.info(`Locus agent listening on ${port}`);
});
