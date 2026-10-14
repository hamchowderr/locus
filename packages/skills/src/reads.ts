import type { HttpMethod } from "@locus/ghl";

/**
 * POST operations that only read. GHL runs searches and some listings as POST, so the method
 * alone cannot tell a read from a write. Reviewed by hand; anything not listed here is a write.
 * (The OAuth token exchanges are POSTs that read nothing from a client and stay off this list.)
 */
export const POST_READS = new Set([
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
  "social-planner.fetch-edit-session-calendar",
  "social-planner.fetch-queue-items",
  "social-planner.fetch-queues",
  "social-planner.fetch-slots",
  "social-planner.get-comment-list",
  "social-planner.get-posts",
  "social-planner.get-statistics",
  "social-planner.get-tags-by-ids",
  "store.get-available-shipping-zones",
  "users.filter-users-by-email",
]);

/**
 * True when the operation only reads from GHL. The one rule for it: the tools route on it, and
 * the generated operation index labels operations with it, so the model reads what the code does.
 */
export function isReadOperation(op: { readonly id: string; readonly method: HttpMethod }): boolean {
  return op.method === "GET" || (op.method === "POST" && POST_READS.has(op.id));
}
