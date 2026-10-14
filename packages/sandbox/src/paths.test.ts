import { describe, expect, it } from "vitest";
import { truncateTail } from "./output.ts";
import { InvalidPathError, validatePath } from "./paths.ts";

describe("validatePath", () => {
  it("accepts and normalises project-relative paths", () => {
    expect(validatePath("app/page.tsx")).toBe("app/page.tsx");
    expect(validatePath("./app//layout.tsx")).toBe("app/layout.tsx");
    expect(validatePath("public/logo.svg/")).toBe("public/logo.svg");
    expect(validatePath("a/./b")).toBe("a/b");
    expect(validatePath("..foo/bar..")).toBe("..foo/bar..");
  });

  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows", "absolute"],
    ["..", '".."'],
    ["../outside", '".."'],
    ["app/../../outside", '".."'],
    ["app/..", '".."'],
    ["a\0b", "NUL"],
    ["app\\page.tsx", "forward slashes"],
    ["~/.ssh/id_rsa", "home"],
    [".", "root"],
    ["./", "root"],
  ])("rejects %j", (path, reason) => {
    expect(() => validatePath(path)).toThrow(InvalidPathError);
    expect(() => validatePath(path)).toThrow(reason);
  });
});

describe("truncateTail", () => {
  it("leaves short output alone", () => {
    expect(truncateTail("hello", 10)).toBe("hello");
    expect(truncateTail("0123456789", 10)).toBe("0123456789");
  });

  it("keeps the tail and says how much was dropped", () => {
    const out = truncateTail(`${"x".repeat(100)}ERROR: at the end`, 17);
    expect(out).toBe("[... 100 characters truncated ...]\nERROR: at the end");
  });
});
