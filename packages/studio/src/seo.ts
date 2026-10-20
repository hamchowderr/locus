import type { SiteFile } from "./workspace.ts";

// What search engines and AI tools will read from a site's files, worked out from the source
// without building it: its pages (the App Router's `app/**/page.tsx`), each page's title and
// description from its `metadata` export, and the site's name and description from
// `lib/site.ts`. Publishing writes the result into `lib/locus.ts` for the sitemap and llms.txt,
// and the builder's check reports the problems it finds.

/** One page of the site, as its files declare it. */
export interface PageSeo {
  /** The page's address on the site, e.g. "/" or "/services". */
  path: string;
  /** The file that renders it. */
  file: string;
  /** As the page's metadata sets it; null when it sets none or Locus can't read it. */
  title: string | null;
  description: string | null;
  /** The page sets a title or description, even one too computed for Locus to read. */
  hasTitle: boolean;
  hasDescription: boolean;
  /** Its `alternates.canonical`, when it sets one. */
  canonical: string | null;
  /** Computed by `generateMetadata`, so the source doesn't say. */
  dynamic: boolean;
  /** The page asks not to be indexed (`robots: { index: false }`). */
  noindex: boolean;
  /** The page adds its own structured data (JSON-LD). */
  schema: boolean;
}

export interface SeoIssue {
  /** The page's path, or "site". */
  page: string;
  problem: string;
}

/** Search results cut titles near 60 characters and descriptions near 160. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 160;

const PAGE_FILE = /^app\/(?:(.+)\/)?page\.(?:tsx|ts|jsx|js|mdx)$/;

/**
 * The address a page file serves, or null for one that serves no fixed address: a dynamic
 * (`[slug]`), parallel (`@slot`), intercepting (`(.)`) or private (`_folder`) segment.
 * Route groups (`(marketing)`) don't appear in the address.
 */
export function pageRoute(file: string): string | null {
  const match = PAGE_FILE.exec(file);
  if (!match) return null;
  const segments = (match[1] ?? "").split("/").filter(Boolean);
  const kept: string[] = [];
  for (const segment of segments) {
    if (/^\(\.{1,3}\)/.test(segment)) return null;
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    if (segment.startsWith("[") || segment.startsWith("@") || segment.startsWith("_")) return null;
    kept.push(segment);
  }
  return `/${kept.join("/")}`;
}

/** A file's text; empty for a binary file. */
const textOf = (file: SiteFile) => (typeof file.content === "string" ? file.content : "");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Values a template literal may use, e.g. `${site.name}`. */
type Vars = Record<string, string | null>;

/**
 * A string literal's value, from its quote onwards. Null when it isn't a plain string: a
 * template literal is read only when everything it puts in is one of `vars`.
 */
function literalAt(source: string, start: number, vars: Vars = {}): string | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      value += next === "n" ? "\n" : next;
      i++;
      continue;
    }
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      const end = source.indexOf("}", i);
      const known = end > 0 ? vars[source.slice(i + 2, end).trim()] : null;
      if (known == null) return null;
      value += known;
      i = end;
      continue;
    }
    if (c === quote) return value;
    value += c;
  }
  return null;
}

/** The first `key: …` in the source: whether there is one, and its value if a plain string. */
function field(source: string, key: string, vars: Vars = {}) {
  const match = new RegExp(`\\b${key}\\s*:\\s*`).exec(source);
  if (!match) return { found: false, value: null };
  const value = literalAt(source, match.index + match[0].length, vars);
  return { found: true, value: value === null ? null : squash(value) };
}

const stringField = (source: string, key: string, vars?: Vars) => field(source, key, vars).value;

/** The text of the `export const metadata` object, or null when there is none. */
function metadataBlock(source: string): string | null {
  const match = /export\s+const\s+metadata\b[^=]*=\s*\{/.exec(source);
  if (!match) return null;
  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
    else if (c === '"' || c === "'" || c === "`") {
      // Skip the string, so a brace inside it doesn't count.
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
    }
  }
  return null;
}

/** A page's title as its metadata sets it: a string, or `{ default }` / `{ absolute }`. */
function titleOf(block: string, vars: Vars) {
  const nested = /\btitle\s*:\s*\{/.exec(block);
  if (!nested) return field(block, "title", vars);
  const inner = block.slice(nested.index);
  const value = stringField(inner, "absolute", vars) ?? stringField(inner, "default", vars);
  return { found: true, value };
}

/** The site's pages and what each declares, home first then by address. */
export function sitePages(files: SiteFile[]): PageSeo[] {
  const facts = siteFacts(files);
  const vars: Vars = { "site.name": facts.name, "site.description": facts.description };
  const pages: PageSeo[] = [];
  for (const file of files) {
    const path = pageRoute(file.path);
    if (path === null) continue;
    const source = textOf(file);
    const block = metadataBlock(source);
    const dynamic = /export\s+(?:async\s+)?function\s+generateMetadata\b/.test(source);
    const none = { found: false, value: null };
    const title = block ? titleOf(block, vars) : none;
    const description = block ? field(block, "description", vars) : none;
    pages.push({
      path,
      file: file.path,
      title: title.value,
      description: description.value,
      hasTitle: title.found,
      hasDescription: description.found,
      canonical: block ? stringField(block, "canonical") : null,
      dynamic,
      noindex: !!block && /\brobots\s*:\s*\{[^}]*\bindex\s*:\s*false/.test(block),
      schema: /application\/ld\+json|<JsonLd\b/.test(source),
    });
  }
  return pages.sort((a, b) =>
    a.path === "/" ? -1 : b.path === "/" ? 1 : a.path < b.path ? -1 : 1,
  );
}

/** The site's name and description from `lib/site.ts`, when it still states them plainly. */
export function siteFacts(files: SiteFile[]): { name: string | null; description: string | null } {
  const file = files.find((f) => f.path === "lib/site.ts");
  const source = file ? textOf(file) : "";
  return { name: stringField(source, "name"), description: stringField(source, "description") };
}

/** An address's path without a trailing slash; a full URL counts by its path. */
function pathOf(address: string): string {
  try {
    return new URL(address, "https://site.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return address;
  }
}

/** What a search engine or person would want fixed, page by page. */
export function seoIssues(files: SiteFile[]): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const pages = sitePages(files);
  const facts = siteFacts(files);
  if (!facts.description) {
    issues.push({ page: "site", problem: "lib/site.ts has no description for the whole site." });
  }
  const titles = new Map<string, string[]>();
  for (const page of pages) {
    if (page.noindex || page.dynamic) continue;
    // The home page may use the layout's default title, the site's name.
    if (!page.hasTitle && page.path !== "/") {
      issues.push({ page: page.path, problem: "No title in the page's metadata." });
    }
    if (page.title && page.title.length > TITLE_MAX) {
      issues.push({
        page: page.path,
        problem: `The title is ${page.title.length} characters; search results cut it near ${TITLE_MAX}.`,
      });
    }
    if (!page.hasDescription && !(page.path === "/" && facts.description)) {
      issues.push({ page: page.path, problem: "No description in the page's metadata." });
    }
    if (page.description && page.description.length > DESCRIPTION_MAX) {
      issues.push({
        page: page.path,
        problem: `The description is ${page.description.length} characters; search results cut it near ${DESCRIPTION_MAX}.`,
      });
    }
    if (!page.canonical) {
      issues.push({
        page: page.path,
        problem: `No canonical address: add alternates: { canonical: "${page.path}" }.`,
      });
    } else if (pathOf(page.canonical) !== pathOf(page.path)) {
      issues.push({
        page: page.path,
        problem: `The canonical address is ${page.canonical}, another page's: search engines will skip this one.`,
      });
    }
    if (page.title) titles.set(page.title, [...(titles.get(page.title) ?? []), page.path]);
  }
  for (const [title, paths] of titles) {
    if (paths.length > 1) {
      issues.push({ page: paths.join(", "), problem: `These pages share the title "${title}".` });
    }
  }
  return issues;
}
