import { describe, expect, it } from "vitest";
import { buildWelcome, type WelcomeFacts } from "./welcome.ts";

const facts: WelcomeFacts = {
  firstName: "Chowderr",
  business: "Sunrise Dental",
  agency: "Flowsper",
  clients: 3,
  notes: 1,
  manager: true,
  github: null,
  vercel: { name: "Otaku" },
  trialDays: 2,
  isNew: true,
};

describe("the chat's welcome", () => {
  it("shows a new agency around, with what is set up and what isn't", () => {
    const w = buildWelcome(facts);
    expect(w.greeting).toBe("Hi Chowderr 👋 let me show you around");
    expect(w.rows.map((r) => [r.label, r.state])).toEqual([
      ["GoHighLevel", "ready"],
      ["Brain", "missing"],
      ["GitHub", "missing"],
      ["Vercel", "ready"],
      ["Free trial", "info"],
    ]);
    expect(w.rows.find((r) => r.label === "GitHub")?.detail).toBe(
      "Not connected: sites can't be published yet.",
    );
    expect(w.rows.find((r) => r.label === "Free trial")?.detail).toContain("2 days left");
    expect(w.starters.map((s) => s.title)).toContain("Fill the brain from the website");
  });

  it("keeps agency settings from members, and greets plainly after the first week", () => {
    const w = buildWelcome({ ...facts, manager: false, isNew: false, notes: 12 });
    expect(w.greeting).toBe("Hi Chowderr 👋");
    expect(w.rows.map((r) => r.label)).toEqual(["GoHighLevel", "Brain"]);
    expect(w.rows[0]?.href).toBeUndefined();
    expect(w.rows[1]?.detail).toBe("12 notes about Sunrise Dental.");
  });
});
