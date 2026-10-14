import type { SiteFile } from "../workspace.ts";

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

/** `lib/locus.ts`: null outside a published site. */
export function locusSettingsFile(settings: { leadEndpoint: string | null }): SiteFile {
  return {
    path: LOCUS_SETTINGS_PATH,
    content: `// Written by Locus each time the site is published. Not secret: it holds no key or token.
// Don't edit it — Locus replaces it. Null in a draft or preview, where forms send nothing.
export const locus = {
  leadEndpoint: ${JSON.stringify(settings.leadEndpoint)} as string | null,
};
`,
  };
}

/** The files to publish: the version's, with Locus's settings for this site in place. */
export function withLocusSettings(
  files: SiteFile[],
  site: { siteId: string; locusUrl: string },
): SiteFile[] {
  const settings = locusSettingsFile({ leadEndpoint: leadEndpoint(site.locusUrl, site.siteId) });
  return [...files.filter((f) => f.path !== LOCUS_SETTINGS_PATH), settings];
}

/** The site's own form route: checks the basics, then forwards to Locus server to server. */
export function leadRouteFile(): SiteFile {
  return {
    path: LEAD_ROUTE_PATH,
    content: `import { NextResponse } from "next/server";
import { locus } from "@/lib/locus";

const MAX_BYTES = 16 * 1024;

/**
 * Receives the site's form submissions and forwards them to Locus, which puts them in the
 * client's CRM. Same origin for the browser; no key or token here or anywhere in the site.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
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
