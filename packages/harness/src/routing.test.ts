import { catalog, isRead } from "@locus/skills";
import { createFakeGhl } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { needsApproval, performAction, SENDS_TO_CONTACT } from "./actions.ts";
import { runQuery } from "./query-data.ts";

const session = { token: "tok", tokenKind: "location", locationId: "loc-A" } as const;

// Every operation in the catalog lands on exactly one of the agent's two paths: reads only
// through query_data, writes only through perform_action, and every deletion waits for a
// person. A refused write sends nothing to GHL.
describe.each(catalog.map((skill) => [skill.category, skill.operations] as const))(
  "%s",
  (_, operations) => {
    test.each(operations.map((op) => [op.id, op] as const))("%s", async (id, op) => {
      const ghl = createFakeGhl({});
      const deps = { session, fetch: ghl.fetch };

      const query = runQuery({ sources: [{ as: "t", operation: id }], sql: "SELECT 1" }, deps)
        // Missing path parameters and the like are fine here; only the routing refusal counts.
        .then(() => "accepted")
        .catch((error: Error) => error.message);

      if (isRead(op)) {
        await expect(performAction({ operation: id }, deps)).rejects.toThrow(/only reads/);
        expect(await query).not.toMatch(/changes data/);
        expect(needsApproval(id)).toBe(false);
      } else {
        expect(await query).toMatch(/changes data/);
        expect(needsApproval(id)).toBe(op.method === "DELETE" || SENDS_TO_CONTACT.has(id));
        expect(ghl.requests).toEqual([]);
      }
    });
  },
);
