import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// GHL refuses redirect and webhook URLs that mention it ("The redirect url contains a Highlevel
// reference"), and every API route is a URL someone may register. Keep the brand out of them.
const BANNED = /ghl|highlevel|gohighlevel|leadconnector/i;
const api = join(import.meta.dirname, "../app/api");

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === "route.ts" ? [`/api/${relative(api, dir)}`] : [];
  });
}

describe("API route paths", () => {
  it("never mention HighLevel", () => {
    const all = routes(api);
    expect(all).toContain("/api/connect/crm/callback");
    expect(all.filter((route) => BANNED.test(route))).toEqual([]);
  });
});
