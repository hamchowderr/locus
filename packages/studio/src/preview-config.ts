import { createHash } from "node:crypto";
import type { SiteFile } from "./workspace.ts";

/**
 * Hosts the preview is opened on. `next dev` refuses its live-reload connection to any other
 * host, and a page in Next 16 waits for that connection before it starts, so without this its
 * buttons and forms never work (a sign-up form sends itself as a plain page load instead).
 */
export const PREVIEW_DEV_HOSTS = ["*.vercel.run"];

/** The config files Next looks for, in the order it takes the first one it finds. */
const CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.mts"];

/**
 * The preview's `next.config`: the draft's own one moves to `next.config.site.*`, and a small
 * one in its place adds the preview's hosts to `allowedDevOrigins`. A draft whose config Next
 * takes is in another form (`next.config.js` or `.mts`) is left as it is.
 *
 * `next dev` restarts only when the file it loaded changes, so the small one carries a hash of
 * the site's own: an edit to the site's settings still reaches the running preview.
 */
export function withPreviewDevHosts(files: SiteFile[], hosts: string[]): SiteFile[] {
  const config = CONFIGS.map((path) => files.find((file) => file.path === path)).find(Boolean);
  if (!config || typeof config.content !== "string" || hosts.length === 0) return files;
  const ext = config.path.slice(config.path.lastIndexOf("."));
  // Next loads .js and .mts with Node's own rules; those rare forms are left as they are.
  if (ext !== ".ts" && ext !== ".mjs") return files;
  const sitePath = `next.config.site${ext}`;
  const header = `// Written by Locus for the preview only. The site's own settings are in ${sitePath}
// (${createHash("sha256").update(config.content).digest("hex").slice(0, 16)}).`;
  const wrapper = ext === ".mjs" ? mjsWrapper(header, hosts) : tsWrapper(header, hosts);
  return [
    ...files.filter((file) => file !== config && file.path !== sitePath),
    { path: sitePath, content: config.content },
    { path: config.path, content: wrapper },
  ];
}

const tsWrapper = (header: string, hosts: string[]) => `${header}
import type { NextConfig } from "next";
import site from "./next.config.site";

type SiteConfig = NextConfig | ((...args: never[]) => NextConfig | Promise<NextConfig>);

const previewHosts: string[] = ${JSON.stringify(hosts)};
const withPreview = (config: NextConfig): NextConfig => ({
  ...config,
  allowedDevOrigins: [...(config.allowedDevOrigins ?? []), ...previewHosts],
});
const config = site as SiteConfig;

export default typeof config === "function"
  ? async (...args: never[]) => withPreview(await config(...args))
  : withPreview(config);
`;

const mjsWrapper = (header: string, hosts: string[]) => `${header}
import site from "./next.config.site.mjs";

const previewHosts = ${JSON.stringify(hosts)};
const withPreview = (config) => ({
  ...config,
  allowedDevOrigins: [...(config.allowedDevOrigins ?? []), ...previewHosts],
});

export default typeof site === "function"
  ? async (...args) => withPreview(await site(...args))
  : withPreview(site);
`;
