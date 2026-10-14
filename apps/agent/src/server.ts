import { serve } from "@hono/node-server";
import { createHost, hostDepsFromEnv } from "./host.ts";

const host = createHost(hostDepsFromEnv());
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: host.fetch, port }, () => {
  console.info(`Locus agent listening on ${port}`);
});
