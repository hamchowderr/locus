import type { AppConnection } from "@locus/harness";
import { describe, expect, it } from "vitest";
import { categoriesOf, directoryHref, filterApps, pageOf, readQuery } from "./directory";

const app = (
  toolkit: string,
  name: string,
  description: string,
  categories: string[],
  connected = false,
): AppConnection => ({
  toolkit,
  name,
  description,
  logo: "",
  categories: categories.map((id) => ({ id, name: id[0]?.toUpperCase() + id.slice(1) })),
  connected,
});

// In the catalog's own order: most used first.
const APPS = [
  app("gmail", "Gmail", "Read and send email", ["email"]),
  app("slack", "Slack", "Team messages and channels", ["chat"], true),
  app("hubspot", "HubSpot", "CRM: contacts, deals and email sequences", ["crm", "email"]),
  app("googlecalendar", "Google Calendar", "See and book events", ["calendar"], true),
  app("notion", "Notión", "Docs and wikis", ["docs"]),
];
const slugs = (apps: AppConnection[]) => apps.map((a) => a.toolkit);

describe("filterApps", () => {
  it("lists connected apps first, otherwise in the catalog's order", () => {
    expect(slugs(filterApps(APPS, { q: "", category: "" }))).toEqual([
      "slack",
      "googlecalendar",
      "gmail",
      "hubspot",
      "notion",
    ]);
  });

  it("keeps an app whose sign-in expired with the connected ones", () => {
    const expired = { ...app("hubspot", "HubSpot", "CRM", ["crm"]), expired: true };
    expect(slugs(filterApps([...APPS.slice(0, 2), expired], { q: "", category: "" }))).toEqual([
      "slack",
      "hubspot",
      "gmail",
    ]);
  });

  it("finds apps by name, slug or description, every word, ignoring case and accents", () => {
    expect(slugs(filterApps(APPS, { q: "NOTION", category: "" }))).toEqual(["notion"]);
    expect(slugs(filterApps(APPS, { q: "google cal", category: "" }))).toEqual(["googlecalendar"]);
    expect(slugs(filterApps(APPS, { q: "googlecalendar", category: "" }))).toEqual([
      "googlecalendar",
    ]);
    expect(slugs(filterApps(APPS, { q: "email deals", category: "" }))).toEqual(["hubspot"]);
    expect(filterApps(APPS, { q: "fax", category: "" })).toEqual([]);
  });

  it("ranks a match in the name above one in the description", () => {
    const apps = [
      app("mailchimp", "Mailchimp", "Campaigns", ["email"]),
      app("outreach", "Outreach", "Sequences that mail", ["email"]),
      app("gmail", "Gmail", "Mail", ["email"]),
    ];
    expect(slugs(filterApps(apps, { q: "mail", category: "" }))).toEqual([
      "mailchimp",
      "gmail",
      "outreach",
    ]);
  });

  it("keeps only the chosen category", () => {
    expect(slugs(filterApps(APPS, { q: "", category: "email" }))).toEqual(["gmail", "hubspot"]);
    expect(slugs(filterApps(APPS, { q: "hub", category: "email" }))).toEqual(["hubspot"]);
    expect(filterApps(APPS, { q: "", category: "nope" })).toEqual([]);
  });
});

describe("categoriesOf", () => {
  it("lists each category once, by name, with how many apps are in it", () => {
    expect(categoriesOf(APPS)).toEqual([
      { id: "calendar", name: "Calendar", count: 1 },
      { id: "chat", name: "Chat", count: 1 },
      { id: "crm", name: "Crm", count: 1 },
      { id: "docs", name: "Docs", count: 1 },
      { id: "email", name: "Email", count: 2 },
    ]);
  });
});

describe("pageOf", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);

  it("cuts a page and says how many there are", () => {
    expect(pageOf(items, 2, 24)).toEqual({
      items: items.slice(24, 48),
      page: 2,
      pages: 3,
      total: 50,
    });
  });

  it("keeps the page number in range", () => {
    expect(pageOf(items, 9, 24).page).toBe(3);
    expect(pageOf(items, 0, 24).page).toBe(1);
    expect(pageOf([], 4, 24)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});

describe("readQuery and directoryHref", () => {
  it("reads the page's search params, falling back on anything odd", () => {
    expect(readQuery({ q: "  slack ", category: "chat", page: "3" })).toEqual({
      q: "slack",
      category: "chat",
      page: 3,
    });
    expect(readQuery({ q: ["a"], page: "-2" })).toEqual({ q: "", category: "", page: 1 });
    expect(readQuery({ page: "abc" }).page).toBe(1);
    expect(readQuery({ q: "x".repeat(500) }).q).toHaveLength(100);
  });

  it("links to the directory, leaving out defaults and keeping odd text inside the query", () => {
    expect(directoryHref({})).toBe("/apps");
    expect(directoryHref({ q: "", category: "", page: 1 })).toBe("/apps");
    expect(directoryHref({ q: "a&b", category: "crm", page: 2 })).toBe(
      "/apps?q=a%26b&category=crm&page=2",
    );
  });
});
