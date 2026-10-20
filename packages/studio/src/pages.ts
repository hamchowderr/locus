/** A page of a site, as its preview's page switcher lists it. */
export interface SitePage {
  /** The address on the site, e.g. `/` or `/services`. */
  route: string;
  /** The page file it comes from, e.g. `app/services/page.tsx`. */
  path: string;
}

const PAGE_FILE = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;

/**
 * The pages a Next.js App Router site serves, from its file paths, home first, then by
 * address. Route groups (`(marketing)`) leave the address; parallel routes (`@modal`), private
 * folders (`_parts`) and pages that need a value in the address (`[slug]`) are left out,
 * since there is no single address to open.
 */
export function sitePages(paths: string[]): SitePage[] {
  const pages = new Map<string, SitePage>();
  for (const path of paths) {
    const match = PAGE_FILE.exec(path);
    if (!match) continue;
    const segments = (match[1] ?? "").split("/").filter(Boolean);
    if (segments.some((s) => s.startsWith("[") || s.startsWith("@") || s.startsWith("_"))) {
      continue;
    }
    const route = `/${segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/")}`;
    if (!pages.has(route)) pages.set(route, { route, path });
  }
  return [...pages.values()].sort((a, b) =>
    a.route === "/" ? -1 : b.route === "/" ? 1 : a.route.localeCompare(b.route),
  );
}
