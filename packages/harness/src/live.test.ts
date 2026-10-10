/**
 * Level 3 — live smoke against a real GHL sub-account. Read-only: nothing here writes.
 *
 * Runs only with LOCUS_LIVE=1 plus a Private Integration Token for one sub-account:
 *   LOCUS_LIVE=1 GHL_API_KEY=… GHL_LOCATION_ID=… pnpm --filter @locus/harness test:live
 * (In a proxied cloud session also set NODE_USE_ENV_PROXY=1.)
 *
 * Assertions compare our results with GHL's own totals, never with fixed numbers, and nothing
 * from the account is printed — it is a real client's data.
 */

import { type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { describe, expect, test } from "vitest";
import { runQuery } from "./query-data.ts";

const token = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const live = process.env.LOCUS_LIVE === "1" && Boolean(token && locationId);

describe.skipIf(!live)("live GHL (read-only)", () => {
  const session: GhlSession = {
    token: token ?? "",
    tokenKind: "location",
    locationId: locationId ?? "",
  };

  test("query_data pages through every contact and matches GHL's total", async () => {
    const search = operationById("contacts.search-contacts-advanced");
    if (!search) throw new Error("catalog is missing contacts search");
    const first = await ghlRequest<{ total: number }>(search, session, {
      body: { page: 1, pageLimit: 1 },
    });

    const result = await runQuery(
      {
        sources: [{ as: "contacts", operation: search.id }],
        sql: "SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS ids FROM contacts",
      },
      { session },
    );

    expect(result.sources[0]?.complete).toBe(true);
    expect(result.rows[0]).toEqual({ n: first.total, ids: first.total });
  }, 120_000);

  test("tags and workflows load and aggregate in SQL", async () => {
    const result = await runQuery(
      {
        sources: [
          { as: "tags", operation: "locations.get-location-tags" },
          { as: "workflows", operation: "workflows.get-workflow" },
        ],
        sql: `SELECT (SELECT COUNT(*) FROM tags) AS tags,
                     (SELECT COUNT(*) FROM workflows) AS workflows,
                     (SELECT COUNT(*) FROM workflows WHERE status = 'published') AS published`,
      },
      { session },
    );

    const [row] = result.rows as [{ tags: number; workflows: number; published: number }];
    expect(row.tags).toBeGreaterThan(0);
    expect(row.workflows).toBeGreaterThanOrEqual(row.published);
    expect(result.sources.every((s) => s.complete)).toBe(true);
  }, 60_000);

  test("forEach chains opportunities to the contacts behind them", async () => {
    const result = await runQuery(
      {
        sources: [
          { as: "opps", operation: "opportunities.search-opportunity" },
          {
            as: "people",
            operation: "contacts.get-contact",
            forEach: { from: "opps", column: "contactId", param: "contactId" },
          },
        ],
        sql: `SELECT COUNT(DISTINCT o.contactId) AS wanted, COUNT(DISTINCT p.id) AS found
              FROM opps o LEFT JOIN people p ON p._key = o.contactId`,
      },
      { session },
    );

    const [row] = result.rows as [{ wanted: number; found: number }];
    expect(row.found).toBe(row.wanted);
  }, 60_000);
});
