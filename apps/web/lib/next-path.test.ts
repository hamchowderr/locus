import { describe, expect, it } from "vitest";
import { safeNext } from "./next-path.ts";

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
