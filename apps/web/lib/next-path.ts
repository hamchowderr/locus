/** Where to go after signing in or up: a path on this site only, never another host. */
export function safeNext(value: unknown, fallback: string): string {
  const path = typeof value === "string" ? value : "";
  const local = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
  return local ? path : fallback;
}

/**
 * Where a site form goes back to: the Sites page, or one of a site's own pages (its build,
 * settings, versions or database page). Any other value is the Sites page.
 */
export function sitesReturn(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  return /^\/sites(\/[A-Za-z0-9_-]{1,64}(\/(settings|versions|database))?)?$/.test(path)
    ? path
    : "/sites";
}
