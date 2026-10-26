import { describe, expect, it } from "vitest";
import { readSetupSummary, setupNote } from "./setup-summary.ts";
import { createStubGhl } from "./stub.ts";

const session = {
  token: "stub-location-token-stub-location-1-1",
  tokenKind: "location" as const,
  locationId: "stub-location-1",
};

describe("a sub-account's GoHighLevel setup", () => {
  it("reads what it sells, books and tracks, by name, and notes what it couldn't read", async () => {
    const summary = await readSetupSummary(session, { fetch: createStubGhl() });
    expect(summary).toEqual({
      products: ["Teeth whitening", "Checkup"],
      calendars: ["New patient visit"],
      pipelines: [{ name: "New patients", stages: ["Enquiry", "Booked"] }],
      customFields: ["Insurance provider"],
      forms: [],
      workflows: [],
      unread: ["Forms", "Workflows"],
    });
  });

  it("refuses another sub-account's setup", async () => {
    const summary = await readSetupSummary(
      { ...session, locationId: "stub-location-2" },
      { fetch: createStubGhl() },
    );
    expect(summary.products).toEqual([]);
    expect(summary.unread).toContain("Products");
  });

  it("writes it as a dated note, leaving out what it couldn't read", () => {
    const note = setupNote(
      {
        products: ["Checkup"],
        calendars: [],
        pipelines: [{ name: "New patients", stages: ["Enquiry", "Booked"] }],
        customFields: [],
        forms: [],
        workflows: [],
        unread: ["Workflows"],
      },
      "Sunrise Dental",
      new Date("2026-10-26T12:00:00Z"),
    );
    expect(note).toContain("# How Sunrise Dental is set up in GoHighLevel");
    expect(note).toContain("on 2026-10-26");
    expect(note).toContain("- Checkup");
    expect(note).toContain("- New patients: Enquiry → Booked");
    expect(note).toContain("## Calendars\n\nNone set up yet.");
    expect(note).not.toContain("## Workflows");
    expect(note).toContain("Not read (Locus couldn't see them): Workflows.");
  });
});
