import { z } from "zod";

/**
 * Adding shadcn/ui components from a registry, without the shadcn CLI: the item's JSON is read
 * (from inside the sandbox, never from Locus's servers), its files are written into the site's
 * draft like any other file, and its npm packages go through the same exact-version path as
 * add_dependency.
 *
 * Official components are named (`dialog`) and come from shadcn's registry at
 * `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, the style the site's components
 * use. Another shadcn-compatible registry's item is given by its https URL.
 */
export const OFFICIAL_REGISTRY = "https://ui.shadcn.com/r/styles/new-york-v4";

/** Items one call may add, counting the components it depends on. */
export const MAX_REGISTRY_ITEMS = 12;

const COMPONENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The registry URL for a component name or an item URL, or why it can't be used. */
export function registryUrl(ref: string): string | { error: string } {
  const value = ref.trim();
  if (COMPONENT_NAME.test(value)) return `${OFFICIAL_REGISTRY}/${value}.json`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      error: `"${ref}" isn't a component name (e.g. dialog) or a registry item's https URL.`,
    };
  }
  if (url.protocol !== "https:" || url.username || url.password || value.length > 500) {
    return { error: "A registry item's URL must be a plain https address." };
  }
  return url.toString();
}

const RegistryFile = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(200_000).optional(),
  type: z.string().max(60).optional(),
  target: z.string().max(300).optional(),
});

export const RegistryItem = z.object({
  name: z.string().min(1).max(100),
  type: z.string().max(60).optional(),
  dependencies: z.array(z.string().max(250)).max(50).optional(),
  devDependencies: z.array(z.string().max(250)).max(50).optional(),
  registryDependencies: z.array(z.string().max(500)).max(50).optional(),
  files: z.array(RegistryFile).max(50).optional(),
  cssVars: z.record(z.string(), z.unknown()).optional(),
  css: z.record(z.string(), z.unknown()).optional(),
  docs: z.string().max(10_000).optional(),
});
export type RegistryItem = z.infer<typeof RegistryItem>;

const base = (path: string) => path.split("/").at(-1) ?? path;

/**
 * Where an item's file goes in the site, by its `target` or its type, as the shadcn CLI lays
 * out a project with the site's aliases (components.json).
 */
export function siteTarget(file: z.infer<typeof RegistryFile>, itemType?: string): string | null {
  if (file.target) return file.target.replace(/^~\//, "").replace(/^\.\//, "");
  switch (file.type ?? itemType) {
    case "registry:ui":
      return `components/ui/${base(file.path)}`;
    case "registry:lib":
      return `lib/${base(file.path)}`;
    case "registry:hook":
      return `hooks/${base(file.path)}`;
    case "registry:component":
    case "registry:block":
    case "registry:example":
      return `components/${base(file.path)}`;
    default:
      // Pages, plain files and styles need an explicit target.
      return null;
  }
}

/** Top-level folders a registry item's files may go in. */
const ALLOWED_ROOTS = new Set(["components", "lib", "hooks", "app"]);

/** Build, runtime and tooling configuration, never written from a registry. */
const CONFIG_FILE =
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|components\.json|vercel\.json|(tsconfig|jsconfig)(\..*)?\.json|(next|postcss|tailwind|eslint|prettier|vite|vitest|biome)\.config\..*|(middleware|instrumentation|instrumentation-client|proxy)\.[cm]?[jt]sx?)$/i;

/**
 * Why a registry item's file may not be written at `path` (already normalized), or null. A
 * third-party registry's files land in the deployed site, so they go only into the component,
 * lib, hook and app folders, never into configuration or a dot-folder. (An app/ file the site
 * already has is never replaced either: add_dependency keeps it.)
 */
export function registryTargetRefusal(path: string): string | null {
  const segments = path.split("/");
  if (segments.some((s) => s.startsWith("."))) {
    return `A registry item can't write ${path}: dot-files and dot-folders are off limits.`;
  }
  const name = segments.at(-1) ?? "";
  if (segments.length < 2 || !ALLOWED_ROOTS.has(segments[0] ?? "") || CONFIG_FILE.test(name)) {
    return (
      `A registry item can't write ${path}: its files may only go under components/, lib/, ` +
      "hooks/ or app/, and never be configuration."
    );
  }
  return null;
}

/**
 * The URL of an item's registry dependency, or why it can't be used: official names resolve to
 * the official registry, and a URL must be on the same origin as the item first asked for, so
 * one registry can't pull in another's files.
 */
export function dependencyUrl(dep: string, rootUrl: string): string | { error: string } {
  const url = registryUrl(dep);
  if (typeof url !== "string" || COMPONENT_NAME.test(dep.trim())) return url;
  if (new URL(url).origin !== new URL(rootUrl).origin) {
    return {
      error: `The component depends on ${url}, which isn't on ${new URL(rootUrl).origin}, the registry it came from.`,
    };
  }
  return url;
}

/** Registry-internal imports, rewritten to the site's aliases (as the CLI does). */
export function rewriteImports(content: string): string {
  return content.replace(
    /(["'])@\/registry\/[^/"']+\/(ui|lib|hooks|components|blocks)\//g,
    (_, quote: string, kind: string) =>
      `${quote}@/${kind === "ui" ? "components/ui" : kind === "blocks" ? "components" : kind}/`,
  );
}

/** "radix-ui", "@scope/pkg@^1.2" → the bare package name. */
export function packageOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Runs inside the sandbox: fetches one registry item and prints its JSON. */
export const REGISTRY_FETCH_SCRIPT = `
const url = process.argv[1];
const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
if (!res.ok) { console.error("HTTP " + res.status); process.exit(2); }
const text = await res.text();
if (text.length > 1000000) { console.error("The registry item is too large."); process.exit(3); }
process.stdout.write(text);
`;
