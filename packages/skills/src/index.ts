import type { GhlOperation } from "@locus/ghl";
import type { Pagination } from "./docs/parse.ts";

export type { Pagination };

/** A GHL operation plus what an agent needs to choose it. */
export interface SkillOperation extends GhlOperation {
  readonly title: string;
  /** First sentence of GHL's description. */
  readonly summary: string;
  readonly deprecated: boolean;
  /** Documented query parameters the caller may set (session parameters excluded). */
  readonly queryParams: readonly string[];
  readonly pagination?: Pagination;
  /** GHL's docs page for the operation. */
  readonly docs: string;
}

/** What every generated `catalog/<category>/manifest.ts` exports by default. */
export interface SkillManifest {
  /** The GHL service name as the live docs spell it, e.g. `opportunities`. */
  readonly category: string;
  /** GHL's own title for the service, e.g. `Opportunities API v3`. */
  readonly label: string;
  /** The docs version the manifest was generated from, e.g. `v3`. */
  readonly docsVersion: string;
  readonly operations: readonly SkillOperation[];
}

export { catalog, docsSource } from "./generated/catalog.ts";
export { isRead, operationById, POST_READS, skillByCategory, skillDocs } from "./lookup.ts";
