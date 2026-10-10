import { readFileSync } from "node:fs";
import { catalog } from "./generated/catalog.ts";
import type { SkillManifest, SkillOperation } from "./index.ts";

const byId = new Map<string, SkillOperation>(
  catalog.flatMap((skill) => skill.operations.map((op) => [op.id, op] as const)),
);
const byCategory = new Map<string, SkillManifest>(catalog.map((skill) => [skill.category, skill]));

/**
 * POST operations that only read. GHL runs searches and some listings as POST, so the method
 * alone cannot tell a read from a write. Reviewed by hand; anything not listed here is a write.
 * (The OAuth token exchanges are POSTs that read nothing from a client and stay off this list.)
 */
const POST_READS = new Set([
  "ad-publishing.google-get-keyword-ideas",
  "contacts.search-contacts-advanced",
  "knowledge-base.get-sitemap-preview",
  "locations.task-search",
  "objects.search-notes",
  "objects.search-object-records",
  "opportunities.search-opportunities-advanced",
  "saas-api.list-agency-wallet-transactions",
  "saas-api.list-location-wallet-transactions",
  "social-planner.fetch-calendar-list",
  "social-planner.get-comment-list",
  "social-planner.get-posts",
  "social-planner.get-statistics",
  "social-planner.get-tags-by-ids",
  "store.get-available-shipping-zones",
  "users.filter-users-by-email",
]);

export function operationById(id: string): SkillOperation | undefined {
  return byId.get(id);
}

export function skillByCategory(category: string): SkillManifest | undefined {
  return byCategory.get(category);
}

/** True when the operation only reads from GHL. */
export function isRead(op: SkillOperation): boolean {
  return op.method === "GET" || (op.method === "POST" && POST_READS.has(op.id));
}

/** The skill's hand-written guidance plus its generated operation index. */
export function skillDocs(category: string): { skill: string; operations: string } | undefined {
  if (!byCategory.has(category)) return undefined;
  const file = (name: string) =>
    readFileSync(new URL(`../catalog/${category}/${name}`, import.meta.url), "utf8");
  return { skill: file("SKILL.md"), operations: file("operations.md") };
}

export { POST_READS };
