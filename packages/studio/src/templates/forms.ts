import { siteFacts, sitePages } from "../seo.ts";
import type { SiteFile } from "../workspace.ts";
import { withSearchFiles } from "./search.ts";

// How a generated site's forms reach the client's CRM, without a credential in the site:
//
//   browser → the site's own /api/lead (same origin) → Locus /api/sites/<siteId>/leads
//
// `lib/locus.ts` holds the one setting the route needs: where to forward. It is public (a site
// id and Locus's address, no key) and Locus writes it on every publish, so a draft or a preview
// has none and the route answers without sending anything.

/** The file Locus owns in every site; replaced on every publish. */
export const LOCUS_SETTINGS_PATH = "lib/locus.ts";
/** The site's own route that every form posts to. */
export const LEAD_ROUTE_PATH = "app/api/lead/route.ts";

/** Locus's endpoint for one site's form submissions. */
export function leadEndpoint(locusUrl: string, siteId: string): string {
  return new URL(`/api/sites/${encodeURIComponent(siteId)}/leads`, locusUrl).toString();
}

/** What Locus writes into `lib/locus.ts`. */
export interface LocusSettings {
  /** Where the form route forwards; null outside a published site. */
  leadEndpoint: string | null;
  /** The site's main public address (`https://…`), when Locus knows it. */
  siteUrl: string | null;
  /** The name and description for the sitemap, llms.txt and search tools. */
  site: { name: string; description: string };
  /** The pages to list in the sitemap and llms.txt. */
  pages: { path: string; title: string; description: string }[];
}

/** `lib/locus.ts`: null and empty outside a published site. */
export function locusSettingsFile(settings: Partial<LocusSettings> = {}): SiteFile {
  const s: LocusSettings = {
    leadEndpoint: null,
    siteUrl: null,
    site: { name: "", description: "" },
    pages: [],
    ...settings,
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");
  return {
    path: LOCUS_SETTINGS_PATH,
    content: `// Written by Locus each time the site is published. Not secret: it holds no key or token.
// Don't edit it — Locus replaces it. Null in a draft or preview, where forms send nothing and
// search engines are asked not to index the site.
export const locus = {
  leadEndpoint: ${JSON.stringify(s.leadEndpoint)} as string | null,
  siteUrl: ${JSON.stringify(s.siteUrl)} as string | null,
  site: ${json(s.site)},
  pages: ${json(s.pages)} as { path: string; title: string; description: string }[],
};

/** Published by Locus, and not a host's preview build: search engines may index it. */
export const published = locus.leadEndpoint !== null && process.env.VERCEL_ENV !== "preview";

/**
 * The site's public address, without a trailing slash: Locus's choice, else the host's own
 * production address. Null in a draft or preview.
 */
export function siteUrl(): string | null {
  if (!published) return null;
  if (locus.siteUrl) return locus.siteUrl.replace(/[/]+$/, "");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? \`https://\${host}\` : null;
}
`,
  };
}

/**
 * The files to publish: the version's, with Locus's settings for this site in place and
 * Locus's search files (sitemap, robots.txt, llms.txt) added or refreshed.
 */
export function withLocusSettings(
  files: SiteFile[],
  site: { siteId: string; locusUrl: string; siteUrl?: string | null; name?: string },
): SiteFile[] {
  const facts = siteFacts(files);
  const name = facts.name || site.name || "Home";
  const description = facts.description ?? "";
  const pages = sitePages(files)
    .filter((p) => !p.noindex)
    .map((p) => ({
      path: p.path,
      title: p.title ?? (p.path === "/" ? name : p.path.slice(1)),
      description: p.description ?? (p.path === "/" ? description : ""),
    }));
  const settings = locusSettingsFile({
    leadEndpoint: leadEndpoint(site.locusUrl, site.siteId),
    siteUrl: site.siteUrl ?? null,
    site: { name, description },
    pages,
  });
  return withSearchFiles([...files.filter((f) => f.path !== LOCUS_SETTINGS_PATH), settings]);
}

/** The site's own form route: checks the basics, then forwards to Locus server to server. */
export function leadRouteFile(): SiteFile {
  return {
    path: LEAD_ROUTE_PATH,
    content: `import { NextResponse } from "next/server";
import { locus } from "@/lib/locus";

const MAX_BYTES = 16 * 1024;

/** The body as text, counted as it arrives; null past MAX_BYTES, whatever Content-Length says. */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Receives the site's form submissions and forwards them to Locus, which puts them in the
 * client's CRM. Same origin for the browser; no key or token here or anywhere in the site.
 */
export async function POST(request: Request) {
  const raw = await readBody(request);
  if (raw === null) {
    return NextResponse.json({ error: "That's too much to send." }, { status: 413 });
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "That form didn't send anything." }, { status: 400 });
  }
  if (!locus.leadEndpoint) {
    // A draft or preview: nothing is sent anywhere.
    return NextResponse.json({ ok: true, preview: true });
  }
  const visitorIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "";
  const response = await fetch(locus.leadEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-locus-visitor-ip": visitorIp },
    body: raw,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) {
    return NextResponse.json({ error: "That didn't send. Please try again." }, { status: 502 });
  }
  const result = (await response.json().catch(() => ({}))) as { error?: unknown };
  const retryAfter = response.headers.get("retry-after");
  return NextResponse.json(
    response.ok
      ? { ok: true }
      : { error: typeof result.error === "string" ? result.error : "That didn't send." },
    { status: response.status, headers: retryAfter ? { "retry-after": retryAfter } : {} },
  );
}
`,
  };
}
