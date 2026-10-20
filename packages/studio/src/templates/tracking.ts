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
const GHL_HOSTS = [/(^|\.)leadconnectorhq\.com$/, /(^|\.)msgsndr\.com$/];

/** Whether the script comes from GHL's own domains (not an agency's white-label one). */
export function isGhlTrackingHost(src: string): boolean {
  const host = URL.canParse(src) ? new URL(src).hostname : "";
  return GHL_HOSTS.some((re) => re.test(host));
}

/**
 * The script's address and tracking id from the snippet GHL shows (`<script src="…"
 * data-tracking-id="tk_…"></script>`), or null when it isn't one. Only an https script at
 * `/js/external-tracking.js` with no port, login or query is accepted.
 */
export function parseTrackingSnippet(snippet: string): GhlTracking | null {
  if (snippet.length > 2000) return null;
  const tag = snippet.match(/<script\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (name: string) =>
    tag
      .match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
      ?.slice(1)
      .find((v) => v !== undefined);
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

/**
 * The root layout with `<GhlTracking />` at the end of `<body>`, or null when the layout has no
 * `</body>` to put it before. A layout that already renders it is returned unchanged.
 */
export function layoutWithTracking(layout: string): string | null {
  if (layout.includes("<GhlTracking")) return layout;
  const body = layout.lastIndexOf("</body>");
  if (body === -1) return null;
  const indent = layout.slice(layout.lastIndexOf("\n", body) + 1, body);
  const withTag = `${layout.slice(0, body)}  <GhlTracking />\n${indent}${layout.slice(body)}`;
  const imports = [...withTag.matchAll(/^import\b[^;]*;[^\S\n]*$/gm)];
  const last = imports.at(-1);
  if (!last || last.index === undefined) return `${IMPORT_LINE}\n${withTag}`;
  const end = last.index + last[0].length;
  return `${withTag.slice(0, end)}\n${IMPORT_LINE}${withTag.slice(end)}`;
}
