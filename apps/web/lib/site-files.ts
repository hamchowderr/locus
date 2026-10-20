import {
  blobFileStore,
  type SiteFileStore,
  type SiteFilesDeps,
  siteFilesKey,
} from "@locus/connect";
import { deriveSecretsSubkey } from "@locus/secrets";
import { configured } from "./connect.ts";
import { locus, NotConfigured } from "./locus.ts";

// App-style sites' files: one private Vercel Blob store on Otaku's account. Its read–write
// token (`LOCUS_SITE_FILES_BLOB_TOKEN`) is Otaku's own secret, in Infisical; sites never get
// it. Each site's files key is derived from `LOCUS_SECRETS_KEY`, so it is stored nowhere.

const TOKEN_ENV = "LOCUS_SITE_FILES_BLOB_TOKEN";

/** Whether this deployment can keep sites' files. Without it, sites get no files key. */
export function siteFilesConfigured(): boolean {
  return Boolean(process.env[TOKEN_ENV] && process.env.LOCUS_SECRETS_KEY);
}

const filesKey = () => configured(() => deriveSecretsSubkey("locus/site-files"));

/** The files key Locus sets on one site's host. Server-side only; never logged. */
export const siteFilesKeyFor = (siteId: string) => siteFilesKey(filesKey(), siteId);

export function siteFileStore(): SiteFileStore {
  const token = process.env[TOKEN_ENV];
  if (!token) throw new NotConfigured(`${TOKEN_ENV} is not set`);
  return blobFileStore(token);
}

/** Everything the sites' file routes need. Throws `NotConfigured` without storage. */
export function siteFilesDeps(): SiteFilesDeps {
  return { db: locus().db, store: siteFileStore(), filesKey: filesKey() };
}
