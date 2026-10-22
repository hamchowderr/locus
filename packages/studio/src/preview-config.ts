import type { SiteFile } from "./workspace.ts";

/**
 * Hosts the preview is opened on. `next dev` refuses its live-reload connection to any other
 * host, and a page in Next 16 waits for that connection before it starts, so without this its
 * buttons and forms never work (a sign-up form sends itself as a plain page load instead).
 */
export const PREVIEW_DEV_HOSTS = ["*.vercel.run"];

const CONFIGS = ["next.config.ts", "next.config.mjs"];

/**
 * The preview's `next.config`: the draft's own one moves to `next.config.site.*`, and a small
 * one in its place adds the preview's hosts to `allowedDevOrigins`. A draft whose config is in
 * another form (CommonJS `next.config.js`) is left as it is.
 */
export function withPreviewDevHosts(files: SiteFile[], hosts: string[]): SiteFile[] {
  const config = files.find((file) => CONFIGS.includes(file.path));
  if (!config || typeof config.content !== "string" || hosts.length === 0) return files;
  const ext = config.path.slice(config.path.lastIndexOf("."));
  const sitePath = `next.config.site${ext}`;
  const wrapper = ext === ".ts" ? tsWrapper(hosts) : mjsWrapper(hosts);
  return [
    ...files.filter((file) => file !== config && file.path !== sitePath),
    { path: sitePath, content: config.content },
    { path: config.path, content: wrapper },
  ];
}

const HEADER = `// Written by Locus for the preview only. The site's own settings are in next.config.site.`;

const tsWrapper = (hosts: string[]) => `${HEADER}ts
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

const mjsWrapper = (hosts: string[]) => `${HEADER}mjs
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
