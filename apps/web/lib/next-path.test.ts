import { describe, expect, it } from "vitest";
import { safeNext, sitesReturn } from "./next-path.ts";

describe("safeNext", () => {
  it("keeps paths on this site", () => {
    expect(safeNext("/invite/abc", "/")).toBe("/invite/abc");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "evil", "", null]) {
      expect(safeNext(bad, "/")).toBe("/");
    }
  });
});

describe("sitesReturn", () => {
  it("goes back to the Sites page or one of a site's pages", () => {
    expect(sitesReturn("/sites")).toBe("/sites");
    expect(sitesReturn("/sites/abc-1")).toBe("/sites/abc-1");
    expect(sitesReturn("/sites/abc-1/settings")).toBe("/sites/abc-1/settings");
  });

  it("sends anything else to the Sites page", () => {
    for (const value of [null, "", "/chat", "//evil.test", "/sites/a/../../chat", "/sites/a/b/c"]) {
      expect(sitesReturn(value)).toBe("/sites");
    }
  });
});
