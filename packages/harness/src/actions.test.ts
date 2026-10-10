import { createFakeGhl } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { ActionError, loadSkill, needsApproval, performAction } from "./actions.ts";

const session = { token: "tok", tokenKind: "location", locationId: "loc-A" } as const;

describe("performAction", () => {
  test("sends a write through the request layer with the session's client", async () => {
    const ghl = createFakeGhl({ "POST /contacts/": { body: { contact: { id: "c9" } } } });

    const result = await performAction(
      { operation: "contacts.create-contact", params: { body: { firstName: "Ada" } } },
      { session, fetch: ghl.fetch },
    );

    expect(result).toEqual({ contact: { id: "c9" } });
    expect(ghl.requests[0]?.body).toEqual({ firstName: "Ada", locationId: "loc-A" });
  });

  test("refuses reads, unknown operations and a caller-supplied client", async () => {
    const deps = { session, fetch: createFakeGhl({}).fetch };

    await expect(performAction({ operation: "contacts.get-contact" }, deps)).rejects.toThrow(
      /only reads — use query_data/,
    );
    await expect(performAction({ operation: "contacts.nope" }, deps)).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(
      performAction(
        { operation: "contacts.create-contact", params: { body: { locationId: "loc-B" } } },
        deps,
      ),
    ).rejects.toThrow(/locationId comes from the session/);
  });
});

test("deletions, and anything unrecognised, need approval", () => {
  expect(needsApproval("contacts.delete-contact")).toBe(true);
  expect(needsApproval("contacts.create-contact")).toBe(false);
  expect(needsApproval("contacts.nope")).toBe(true);
});

test("loadSkill returns the skill and its operation index", () => {
  expect(loadSkill("forms").operations).toContain("forms.get-forms");
  expect(() => loadSkill("nope")).toThrow(/unknown skill/);
});
