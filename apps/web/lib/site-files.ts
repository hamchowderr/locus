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

/** Everything the sites' file routes need. Throws `NotConfigured` when a part is missing. */
export function siteFilesDeps(): SiteFilesDeps {
  return { ...connectDeps(), filesKey: filesKey(), ipHashKey: siteLeadIpKey() };
}
