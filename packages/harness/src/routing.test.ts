import { catalog, isRead } from "@locus/skills";
import { createFakeGhl } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { needsApproval, performAction } from "./actions.ts";
import { runQuery } from "./query-data.ts";

const session = { token: "tok", tokenKind: "location", locationId: "loc-A" } as const;

// Every operation in the catalog lands on exactly one of the agent's two paths: reads only
// through query_data, writes only through perform_action, and every deletion waits for a
// person. Nothing is sent to GHL on the refused path.
describe.each(catalog.map((skill) => [skill.category, skill.operations] as const))(
  "%s",
  (_, operations) => {
    test.each(operations.map((op) => [op.id, op] as const))("%s", async (id, op) => {
      const ghl = createFakeGhl({});
      const deps = { session, fetch: ghl.fetch };

      if (isRead(op)) {
        await expect(performAction({ operation: id }, deps)).rejects.toThrow(/only reads/);
        expect(needsApproval(id)).toBe(false);
      } else {
        await expect(
          runQuery({ sources: [{ as: "t", operation: id }], sql: "SELECT 1" }, deps),
        ).rejects.toThrow(/changes data/);
        expect(needsApproval(id)).toBe(op.method === "DELETE");
      }
      expect(ghl.requests).toEqual([]);
    });
  },
);
