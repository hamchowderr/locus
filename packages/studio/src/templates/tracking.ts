import type { SiteFile } from "../workspace.ts";

// GHL's external tracking script on a site. GHL gives each sub-account one snippet (Settings →
// External Tracking); on a page it links visitors to contacts, records page views and catches
// native form submissions, so GHL workflows can trigger on them. GHL has no API for the
// snippet, so the person pastes it and the builder's `crm` tool writes it in.
//
// The script only loads on the published site (Locus's settings are null in a draft or
// preview), so building and previewing never counts as a visit.

export const GHL_TRACKING_PATH = "components/ghl-tracking.tsx";

export interface GhlTracking {
  /** `https://<host>/js/external-tracking.js`: GHL's own host, or the agency's link domain. */
  src: string;
  /** `tk_…`, the sub-account's tracking id. */
  trackingId: string;
}

const TRACKING_ID = /^tk_[A-Za-z0-9]{8,64}$/;

/**
 * The script's address and tracking id from the snippet GHL shows (`<script src="…"
 * data-tracking-id="tk_…"></script>`), or null when it isn't one. Only an https script at
 * `/js/external-tracking.js` with no port, login or query is accepted.
 */
export function parseTrackingSnippet(snippet: string): GhlTracking | null {
  if (snippet.length > 2000) return null;
  const tag = snippet.match(/<script\b[^>]*>/i)?.[0];
  if (!tag) return null;
  // Each attribute exactly once, matched as a whole name (`data-src` is not `src`).
  const attr = (name: string) => {
    const found = [
      ...tag.matchAll(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "gi")),
    ];
    return found.length === 1 ? (found[0]?.[1] ?? found[0]?.[2]) : undefined;
  };
  const src = attr("src")?.trim();
  const trackingId = attr("data-tracking-id")?.trim();
  if (!src || !trackingId || !TRACKING_ID.test(trackingId) || !URL.canParse(src)) return null;
  const url = new URL(src);
  const plain =
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === "/js/external-tracking.js" &&
    /^[a-z0-9.-]+$/.test(url.hostname) &&
    url.hostname.includes(".");
  return plain ? { src: url.toString(), trackingId } : null;
}

/** `components/ghl-tracking.tsx` for one snippet. */
export function ghlTrackingFile(tracking: GhlTracking): SiteFile {
  return {
    path: GHL_TRACKING_PATH,
    content: `import Script from "next/script";
import { locus } from "@/lib/locus";

// Written by Locus: the CRM's tracking script (links visitors to contacts, page views, form
// submissions). It loads on the published site only. Replace it with the crm tool, not by hand.

export function GhlTracking() {
  if (!locus.leadEndpoint) return null;
  return (
    <Script
      id="ghl-tracking"
      src=${JSON.stringify(tracking.src)}
      data-tracking-id=${JSON.stringify(tracking.trackingId)}
      strategy="afterInteractive"
    />
  );
}
`,
  };
}

const IMPORT_LINE = 'import { GhlTracking } from "@/components/ghl-tracking";';
const DIRECTIVE = /^\s*["']use (client|server)["'];?\s*$/;
const STATEMENT_END = /["'][^"']*["'];?\s*$/;

/** Where the import goes: after the file's last top-level import, else after any directive. */
function importLine(lines: string[]): number {
  let after = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (DIRECTIVE.test(line)) after = Math.max(after, i + 1);
    else if (/^import\b/.test(line)) {
      // An import runs until the line that ends with its module name, with or without `;`.
      let end = i;
      while (end < lines.length - 1 && !STATEMENT_END.test(lines[end] ?? "")) end++;
      after = end + 1;
      i = end;
    } else if (line.trim() && !/^\s*(\/\/|\/\*|\*)/.test(line)) break;
  }
  return after;
}

/**
 * The root layout rendering `<GhlTracking />` at the end of `<body>`, or null when the layout
 * has no `</body>` to put it before. A layout that already has both the import and the tag is
 * returned unchanged.
 */
export function layoutWithTracking(layout: string): string | null {
  const hasImport = layout.includes(IMPORT_LINE);
  const hasTag = layout.includes("<GhlTracking");
  if (hasImport && hasTag) return layout;
  let updated = layout;
  if (!hasTag) {
    const body = updated.lastIndexOf("</body>");
    if (body === -1) return null;
    const lineStart = updated.lastIndexOf("\n", body) + 1;
    const before = updated.slice(lineStart, body);
    updated = /^\s*$/.test(before)
      ? // `</body>` on its own line: the tag on its own line above it, one level in.
        `${updated.slice(0, lineStart)}${before}  <GhlTracking />\n${updated.slice(lineStart)}`
      : `${updated.slice(0, body)}<GhlTracking />${updated.slice(body)}`;
  }
  if (!hasImport) {
    const lines = updated.split("\n");
    lines.splice(importLine(lines), 0, IMPORT_LINE);
    updated = lines.join("\n");
  }
  return updated;
}
