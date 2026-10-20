import { type SiteFilesDeps, siteFilesKey } from "@locus/connect";
import { deriveSecretsSubkey } from "@locus/secrets";
import { configured, connectDeps, siteLeadIpKey } from "./connect.ts";

// App-style sites' files go into each client's own GHL Media Library, through Locus: sites never
// hold a GHL token. Each site's files key is derived from `LOCUS_SECRETS_KEY`, so it is stored
// nowhere but on the site's host.

/** Whether this deployment can take sites' files. Without it, sites get no files key. */
export function siteFilesConfigured(): boolean {
  return Boolean(process.env.LOCUS_SECRETS_KEY);
}

const filesKey = () => configured(() => deriveSecretsSubkey("locus/site-files"));

/** The files key Locus sets on one site's host. Server-side only; never logged. */
export const siteFilesKeyFor = (siteId: string) => siteFilesKey(filesKey(), siteId);

/**
 * Where members' browsers send bigger files: the agent server, which no Vercel request limit
 * applies to. Null without one; sites then send files of up to 4 MB through this app.
 */
export function bigUploadUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const agent = env.LOCUS_AGENT_URL?.replace(/\/+$/, "");
  return agent ? `${agent}/site-files/upload` : null;
}

/** Signs tickets for bigger uploads; the agent server derives the same key to check them. */
export const siteFileTicketKey = () =>
  configured(() => deriveSecretsSubkey("locus/site-file-ticket"));

/** Everything the sites' file routes need. Throws `NotConfigured` when a part is missing. */
export function siteFilesDeps(): SiteFilesDeps {
  return { ...connectDeps(), filesKey: filesKey(), ipHashKey: siteLeadIpKey() };
}
