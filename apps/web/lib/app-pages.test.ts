import { describe, expect, it } from "vitest";
import { afterSwitch, isCurrent, menuSections } from "./app-pages.ts";

const names = (sections: ReturnType<typeof menuSections>) =>
  sections.map((s) => [s.name, s.pages.map((p) => p.name)]);

describe("menuSections", () => {
  it("shows the sub-account's pages first once one is chosen", () => {
    expect(names(menuSections({ hasSubAccount: true, operator: false }))).toEqual([
      ["Sub-account", ["Chat", "Sites", "Connectors"]],
      ["Agency", ["Sub-accounts", "Team", "Integrations", "Billing"]],
    ]);
  });

  it("leaves out the sub-account's pages until one is chosen", () => {
    expect(names(menuSections({ hasSubAccount: false, operator: false }))).toEqual([
      ["Agency", ["Sub-accounts", "Team", "Integrations", "Billing"]],
    ]);
  });

  it("shows Operator only to operators", () => {
    const agency = menuSections({ hasSubAccount: false, operator: true })[0];
    expect(agency?.pages.map((p) => p.name)).toContain("Operator");
  });
});

describe("isCurrent", () => {
  it("matches the page and the pages under it, not a page that only starts the same", () => {
    expect(isCurrent({ href: "/sites" }, "/sites")).toBe(true);
    expect(isCurrent({ href: "/sites" }, "/sites/abc/versions")).toBe(true);
    expect(isCurrent({ href: "/apps" }, "/apps-other")).toBe(false);
  });
});

describe("afterSwitch", () => {
  it("stays on the same menu page but leaves the previous sub-account's site", () => {
    expect(afterSwitch("/sites/abc/versions")).toBe("/sites");
    expect(afterSwitch("/apps")).toBe("/apps");
  });

  it("opens the chat from an agency page", () => {
    expect(afterSwitch("/clients")).toBe("/chat");
    expect(afterSwitch("/team")).toBe("/chat");
  });
});
