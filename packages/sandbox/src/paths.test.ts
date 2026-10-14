import { describe, expect, it } from "vitest";
import { TailBuffer, truncateTail } from "./output.ts";
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

describe("TailBuffer", () => {
  it("returns short output unchanged", () => {
    const tail = new TailBuffer(10);
    tail.push("abc");
    tail.push("def");
    expect(tail.toString()).toBe("abcdef");
  });

  it("holds a bounded tail of a long stream and counts everything dropped", () => {
    const tail = new TailBuffer(5);
    for (let i = 0; i < 1_000; i++) tail.push("0123456789");
    tail.push("END");
    expect(tail.toString()).toBe("[... 9998 characters truncated ...]\n89END");
  });

  it("decodes bytes leniently, including characters split across chunks", () => {
    const tail = new TailBuffer(100);
    const euro = new TextEncoder().encode("€");
    tail.push(euro.slice(0, 1));
    tail.push(euro.slice(1));
    tail.push(new Uint8Array([0xff, 0x41]));
    expect(tail.toString()).toBe("€�A");
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
