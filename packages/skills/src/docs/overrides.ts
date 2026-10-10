/**
 * Corrections to GHL's docs, verified against a live sub-account. The generator applies these
 * on top of what it parses, and records each one in `source/docs-defects.md`.
 *
 * Add an entry only with evidence from a real response, and say what that evidence was. An
 * override for an operation that no longer exists fails generation, so stale entries surface.
 */

import type { SessionParam } from "@locus/ghl";
import type { Pagination } from "./parse.ts";

export interface Override {
  sessionParams?: SessionParam[];
  pagination?: Pagination;
  /** What was observed, and when. */
  evidence: string;
}

export const OVERRIDES: Record<string, Override> = {
  "contacts.search-contacts-advanced": {
    sessionParams: [{ in: "body", name: "locationId", value: "locationId", required: true }],
    pagination: { style: "page", in: "body", page: "page", size: "pageLimit" },
    evidence:
      "2026-10-10, live sub-account: without locationId in the body → 422 \"locationId can't be " +
      'undefined"; page + pageLimit return non-overlapping pages with `total`; limit/skip → 422 ' +
      '"property limit should not exist". The docs show the body as a free-form object.',
  },
};
