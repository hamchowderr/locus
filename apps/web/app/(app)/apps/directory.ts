/**
 * The Apps page's directory: searching, filtering and paging the apps Locus offers. Pure, so
 * the page stays a server render and these are tested on their own.
 */

import type { AppConnection } from "@locus/harness";

/** Apps on one page of the directory. Enough to scan, few enough logos to load at once. */
export const PAGE_SIZE = 24;

export interface DirectoryQuery {
  q: string;
  category: string;
  page: number;
}

/** The query from the page's search params; anything odd falls back to the default. */
export function readQuery(params: { q?: unknown; category?: unknown; page?: unknown }) {
  const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 100) : "");
  const page = Number.parseInt(text(params.page), 10);
  return {
    q: text(params.q),
    category: text(params.category),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  } satisfies DirectoryQuery;
}

/** Every category the apps are in, by name, with how many apps each holds. */
export function categoriesOf(apps: AppConnection[]) {
  const found = new Map<string, { id: string; name: string; count: number }>();
  for (const app of apps) {
    for (const category of app.categories) {
      const known = found.get(category.id);
      if (known) known.count += 1;
      else found.set(category.id, { ...category, count: 1 });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const fold = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * The apps matching the search and category, connected ones first and otherwise in the
 * catalog's own order (most used first). Every word searched must appear in the app's name,
 * slug or description; a match in the name ranks above one in the description.
 */
export function filterApps<T extends AppConnection>(
  apps: T[],
  { q, category }: Pick<DirectoryQuery, "q" | "category">,
): T[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const scored = apps.flatMap((app, index) => {
    if (category && !app.categories.some((c) => c.id === category)) return [];
    const name = fold(`${app.name} ${app.toolkit}`);
    const all = `${name} ${fold(app.description)}`;
    if (!words.every((word) => all.includes(word))) return [];
    const inName = words.length > 0 && words.every((word) => name.includes(word));
    return [
      {
        app,
        index,
        rank: (app.connected || app.expired ? 0 : 2) + (inName || words.length === 0 ? 0 : 1),
      },
    ];
  });
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map((s) => s.app);
}

/** One page of the apps, the page number kept within range. */
export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    pages,
    total: items.length,
  };
}

/** A link to the directory with this query, leaving out what is default. */
export function directoryHref({ q, category, page }: Partial<DirectoryQuery>): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (page && page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/apps?${query}` : "/apps";
}
