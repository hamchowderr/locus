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

/** Where the string starting at `start` ends (its closing quote), skipping escapes. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

/** The source with its comments blanked out, so a quote or brace in one counts for nothing. */
function withoutComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(source, i);
      out += source.slice(i, end + 1);
      i = end;
    } else if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** The object literal opening at `open` (a `{`), braces in strings not counted. */
function objectAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") i = stringEnd(source, i);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Where each of an object literal's own keys' values starts; nested objects' keys excluded. */
function ownKeys(object: string): Map<string, number> {
  const keys = new Map<string, number>();
  let depth = 0;
  for (let i = 0; i < object.length; i++) {
    const c = object[i] as string;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(object, i);
      const after = /^\s*:\s*/.exec(object.slice(end + 1));
      if (depth === 1 && c !== "`" && after && /[{,]\s*$/.test(object.slice(0, i))) {
        keys.set(object.slice(i + 1, end), end + 1 + after[0].length);
      }
      i = end;
    } else if (depth === 1 && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(object[i - 1] ?? "")) {
      const key = /^[\w$]+/.exec(object.slice(i))?.[0] ?? c;
      const after = /^\s*:\s*/.exec(object.slice(i + key.length));
      if (after && /[{,]\s*$/.test(object.slice(0, i)) && !keys.has(key)) {
        keys.set(key, i + key.length + after[0].length);
      }
      i += key.length - 1;
    }
  }
  return keys;
}

/** One of the object's own keys: whether it is there, and its value if a plain string. */
function field(object: string, key: string, vars: Vars = {}) {
  const at = ownKeys(object).get(key);
  if (at === undefined) return { found: false, value: null };
  const value = literalAt(object, at, vars);
  return { found: true, value: value === null ? null : squash(value) };
}

const stringField = (object: string, key: string, vars?: Vars) => field(object, key, vars).value;

/** The object literal a key of `object` holds, or null when it holds something else. */
function objectField(object: string, key: string): string | null {
  const at = ownKeys(object).get(key);
  return at !== undefined && object[at] === "{" ? objectAt(object, at) : null;
}

/** The `export const metadata` object, comments blanked; null when there is none. */
function metadataBlock(source: string): string | null {
  const clean = withoutComments(source);
  const match = /export\s+const\s+metadata\b[^=]*=\s*\{/.exec(clean);
  return match ? objectAt(clean, match.index + match[0].length - 1) : null;
}

/** A page's title as its metadata sets it: a string, or `{ default }` / `{ absolute }`. */
function titleOf(block: string, vars: Vars) {
  const nested = objectField(block, "title");
  if (!nested) return field(block, "title", vars);
  const value = stringField(nested, "absolute", vars) ?? stringField(nested, "default", vars);
  return { found: true, value };
}

/** `robots: { index: false }` or a `robots` string saying noindex. */
function isNoindex(block: string): boolean {
  const robots = objectField(block, "robots");
  if (robots) {
    const at = ownKeys(robots).get("index");
    return at !== undefined && /^false\b/.test(robots.slice(at));
  }
  return /noindex/i.test(stringField(block, "robots") ?? "");
}

/** The site's pages and what each declares, home first then by address. */
export function pageSeo(files: SiteFile[]): PageSeo[] {
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
      canonical: (() => {
        const alternates = block ? objectField(block, "alternates") : null;
        return alternates ? stringField(alternates, "canonical") : null;
      })(),
      dynamic,
      noindex: !!block && isNoindex(block),
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
  const source = withoutComments(file ? textOf(file) : "");
  const match = /export\s+const\s+site\b[^=]*=\s*\{/.exec(source);
  const site = match ? objectAt(source, match.index + match[0].length - 1) : "";
  return { name: stringField(site, "name"), description: stringField(site, "description") };
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
  const pages = pageSeo(files);
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
  for (const { file, count } of imagesWithoutAlt(files)) {
    issues.push({
      page: file,
      problem: `${count} ${count === 1 ? "image has" : "images have"} no alt text. Describe each one, or use alt="" for a purely decorative image.`,
    });
  }
  return issues;
}

/**
 * Images (`<img>` or next/image's `<Image>`) with no `alt` at all, per source file. Screen
 * readers and search engines read the alt text; `alt=""` marks a decorative image and counts.
 */
export function imagesWithoutAlt(files: SiteFile[]): { file: string; count: number }[] {
  const found: { file: string; count: number }[] = [];
  for (const file of files) {
    if (!/\.(?:tsx|jsx|mdx)$/.test(file.path) || file.path.startsWith("components/ui/")) continue;
    const source = withoutComments(textOf(file));
    let count = 0;
    for (const [tag] of source.matchAll(/<(?:img|Image)\b[^>]*>/g)) {
      // A spread could carry the alt; only a tag that plainly lacks one counts.
      if (!/\balt\s*=/.test(tag) && !/\{\s*\.\.\./.test(tag)) count++;
    }
    if (count) found.push({ file: file.path, count });
  }
  return found;
}
