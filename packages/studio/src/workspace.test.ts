import type { TenantDb } from "@locus/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSitePath, WorkspaceError } from "./paths.ts";
import { tenantDbForTest } from "./test-db.ts";
import { SiteWorkspace } from "./workspace.ts";

let db: TenantDb;
let close: () => Promise<void>;
let ws: SiteWorkspace;

beforeEach(async () => {
  ({ db, close } = await tenantDbForTest());
  ws = new SiteWorkspace(db, "site-1");
});
afterEach(() => close());

describe("normalizeSitePath", () => {
  it("cleans relative paths", () => {
    expect(normalizeSitePath("./app//page.tsx")).toBe("app/page.tsx");
    expect(normalizeSitePath("app\\page.tsx")).toBe("app/page.tsx");
    expect(normalizeSitePath("app/(marketing)/[slug]/page.tsx")).toBe(
      "app/(marketing)/[slug]/page.tsx",
    );
  });

  it.each([
    "/etc/passwd",
    "../secrets",
    "app/../../x",
    ".git/config",
    "node_modules/x/index.js",
    ".env",
    "config/.env.local",
    ".ENV",
    ".envrc",
    ".npmrc",
    "app/.git/hooks/pre-commit",
    "packages/x/node_modules/y.js",
    "a\0b",
    "",
  ])("refuses %j", (path) => {
    expect(() => normalizeSitePath(path)).toThrow(WorkspaceError);
  });
});

describe("SiteWorkspace", () => {
  it("writes, reads, lists and deletes draft files", async () => {
    await ws.writeFiles([
      { path: "app/page.tsx", content: "export default 1" },
      { path: "public/logo.png", content: new Uint8Array([137, 80, 78, 71]) },
    ]);
    expect(await ws.readFile("app/page.tsx")).toBe("export default 1");
    expect(await ws.readFile("public/logo.png")).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect((await ws.listFiles()).map((f) => f.path)).toEqual(["app/page.tsx", "public/logo.png"]);
    await ws.deleteFiles(["public/logo.png", "missing.txt"]);
    expect(await ws.readFile("public/logo.png")).toBeNull();
  });

  it("keeps sites in the same database apart", async () => {
    await ws.writeFile("a.txt", "one");
    const other = new SiteWorkspace(db, "site-2");
    expect(await other.listFiles()).toEqual([]);
    expect(await other.readFile("a.txt")).toBeNull();
  });

  it("edits a unique match, and refuses missing or ambiguous ones", async () => {
    await ws.writeFile("a.ts", "const a = 1;\nconst b = 1;\n");
    expect(await ws.editFile("a.ts", "const a = 1", "const a = 2")).toBe(1);
    await expect(ws.editFile("a.ts", "nope", "x")).rejects.toThrow(/isn't in a.ts/);
    await expect(ws.editFile("a.ts", "= ", "=")).rejects.toThrow(/occurs 2 times/);
    expect(await ws.editFile("a.ts", "= ", "=", { all: true })).toBe(2);
    expect(await ws.readFile("a.ts")).toBe("const a =2;\nconst b =1;\n");
  });

  it("saves numbered versions only when something changed", async () => {
    await ws.writeFile("a.txt", "one");
    const v1 = await ws.saveVersion({ message: "First", source: "agent" });
    expect(v1?.number).toBe(1);
    expect(await ws.saveVersion({ message: "Again", source: "agent" })).toBeNull();

    await ws.writeFile("a.txt", "two");
    await ws.writeFile("b.txt", "new");
    expect(await ws.changes()).toEqual({ added: ["b.txt"], modified: ["a.txt"], deleted: [] });
    const v2 = await ws.saveVersion({ message: "Second", source: "agent" });
    expect(v2?.number).toBe(2);
    expect(v2?.parentId).toBe(v1?.id);
    expect((await ws.listVersions()).map((v) => v.number)).toEqual([2, 1]);
  });

  it("restores a version as a new version, so restoring can be undone", async () => {
    await ws.writeFile("a.txt", "one");
    const v1 = await ws.saveVersion({ message: "First", source: "agent" });
    await ws.writeFile("a.txt", "two");
    await ws.writeFile("b.txt", "extra");
    await ws.saveVersion({ message: "Second", source: "agent" });

    // biome-ignore lint/style/noNonNullAssertion: saved above
    const v3 = await ws.restoreVersion(v1!.id, { userId: "user-1" });
    expect(v3.number).toBe(3);
    expect(v3.source).toBe("restore");
    expect(v3.message).toBe("Restored version 1");
    expect(await ws.snapshot()).toEqual([{ path: "a.txt", content: "one" }]);
    expect(await ws.versionFiles(v3.id)).toEqual([{ path: "a.txt", content: "one" }]);
  });

  it("discards unsaved changes back to the latest version", async () => {
    await ws.writeFile("a.txt", "one");
    await ws.saveVersion({ message: "First", source: "agent" });
    await ws.writeFile("a.txt", "broken");
    await ws.writeFile("junk.txt", "x");
    await ws.discardDraft();
    expect(await ws.snapshot()).toEqual([{ path: "a.txt", content: "one" }]);
  });

  it("bookmarks versions and records commits, only for this site's versions", async () => {
    await ws.writeFile("a.txt", "one");
    // biome-ignore lint/style/noNonNullAssertion: saved
    const v1 = (await ws.saveVersion({ message: "First", source: "agent" }))!;
    await ws.setBookmark(v1.id, true);
    await ws.setCommitSha(v1.id, "abc123");
    expect(await ws.getVersion(v1.id)).toMatchObject({ bookmarked: true, commitSha: "abc123" });

    const other = new SiteWorkspace(db, "site-2");
    await expect(other.setBookmark(v1.id, false)).rejects.toThrow(/isn't one of this site's/);
    await expect(other.restoreVersion(v1.id)).rejects.toThrow(/isn't one of this site's/);
  });

  it("keeps bytes intact even under a text file name", async () => {
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    await ws.writeFile("data.json", notUtf8);
    await ws.writeFile("logo.png", notUtf8);
    expect(await ws.readFile("data.json")).toEqual(notUtf8);
    expect(await ws.readFile("logo.png")).toEqual(notUtf8);
    // Valid UTF-8 bytes under a text name read back as text.
    await ws.writeFile("note.txt", new TextEncoder().encode("héllo"));
    expect(await ws.readFile("note.txt")).toBe("héllo");
  });

  it("numbers concurrent saves without a clash", async () => {
    await ws.writeFile("a.txt", "one");
    await ws.saveVersion({ message: "First", source: "agent" });
    await ws.writeFile("a.txt", "two");
    const saves = await Promise.all([
      ws.saveVersion({ message: "A", source: "agent" }),
      ws.saveVersion({ message: "B", source: "agent" }),
    ]);
    // One saved version 2; the other found nothing new to save.
    expect(saves.filter(Boolean).map((v) => v?.number)).toEqual([2]);
    expect((await ws.listVersions()).map((v) => v.number)).toEqual([2, 1]);
  });

  it("stores identical content once", async () => {
    await ws.writeFiles([
      { path: "a.txt", content: "same" },
      { path: "b.txt", content: "same" },
    ]);
    const rs = await db.$client.execute("select count(*) as n from site_blob");
    expect(Number(rs.rows[0]?.n)).toBe(1);
  });

  it("refuses an empty save and oversized files", async () => {
    await expect(ws.saveVersion({ message: "x", source: "agent" })).rejects.toThrow(/empty/);
    await expect(ws.writeFile("big.bin", new Uint8Array(5 * 1024 * 1024))).rejects.toThrow(
      /limited/,
    );
  });
});
