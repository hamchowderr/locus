import type { TenantDb } from "@locus/db";
import { createWorkspaceTools, FilesystemError, Workspace } from "@mastra/core/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainFilesystem, buildIndex, summarize } from "./filesystem.ts";
import { listNoteVersions, restoreNoteVersion } from "./store.ts";
import { tenantDbForTest } from "./test-db.ts";

let db: TenantDb;
let close: () => Promise<void>;
let fs: BrainFilesystem;

beforeEach(async () => {
  ({ db, close } = await tenantDbForTest());
  fs = new BrainFilesystem(db, { actor: "agent:test" });
});
afterEach(() => close());

describe("BrainFilesystem", () => {
  it("writes, reads and lists notes in the fixed folders", async () => {
    await fs.writeFile("/business/pricing.md", "# Pricing\n\nRoof repair from $450.");
    await fs.writeFile("instructions.md", "Ask Maria before anything goes to customers.");
    expect(await fs.readFile("/business/pricing.md", { encoding: "utf8" })).toBe(
      "# Pricing\n\nRoof repair from $450.",
    );
    expect(Buffer.isBuffer(await fs.readFile("business/pricing.md"))).toBe(true);
    const top = await fs.readdir("/");
    expect(top.map((e) => `${e.type}:${e.name}`)).toEqual([
      "directory:business",
      "directory:decisions",
      "directory:inbox",
      "file:index.md",
      "file:instructions.md",
      "directory:people",
      "directory:playbooks",
      "directory:sources",
      "directory:work",
    ]);
    expect(await fs.readdir("business")).toEqual([{ name: "pricing.md", type: "file", size: 33 }]);
    expect((await fs.stat("business")).type).toBe("directory");
    expect((await fs.stat("business/pricing.md")).size).toBe(33);
  });

  it("lists recursively with paths relative to the folder", async () => {
    await fs.writeFile("work/sites/spring-promo.md", "x");
    await fs.writeFile("work/fall.md", "y");
    expect((await fs.readdir("work", { recursive: true })).map((e) => e.name)).toEqual([
      "fall.md",
      "sites",
      "sites/spring-promo.md",
    ]);
    expect((await fs.walk("work")).map((e) => e.path)).toEqual([
      "fall.md",
      "sites",
      "sites/spring-promo.md",
    ]);
  });

  it.each([
    ["notes.md", "isn't inside a brain folder"],
    ["contacts/john.md", "isn't inside a brain folder"],
    ["business/logo.png", "isn't a .md file"],
    ["index.md", "built from the notes"],
    ["../x.md", "leaves the brain"],
  ])("refuses to write %s", async (path, message) => {
    const write = fs.writeFile(path, "x");
    await expect(write).rejects.toBeInstanceOf(FilesystemError);
    await expect(write).rejects.toThrow(message);
  });

  it("refuses binary content and oversized notes", async () => {
    await expect(fs.writeFile("business/a.md", new Uint8Array([0xff, 0xfe, 0x00]))).rejects.toThrow(
      "text notes only",
    );
    await expect(fs.writeFile("business/a.md", "x".repeat(300 * 1024))).rejects.toThrow("over");
  });

  it("builds index.md from the notes on every read", async () => {
    await fs.writeFile("business/pricing.md", "# Pricing\n\nRoof repair from $450.");
    await fs.writeFile(
      "decisions/ads.md",
      "---\ndescription: Dropped Facebook ads in October\n---\n# Ads",
    );
    const index = await fs.readFile("index.md", { encoding: "utf8" });
    expect(index).toContain("- business/pricing.md: Roof repair from $450.");
    expect(index).toContain("- decisions/ads.md: Dropped Facebook ads in October");
    expect(index).toContain("- instructions.md: (empty)");
    expect(await fs.exists("index.md")).toBe(true);
    await expect(fs.deleteFile("index.md")).rejects.toThrow("built from the notes");
  });

  it("keeps every change, so a write or a delete can be undone", async () => {
    await fs.writeFile("business/hours.md", "Mon-Fri 9-5");
    await fs.writeFile("business/hours.md", "Mon-Sat 9-5");
    await fs.writeFile("business/hours.md", "Mon-Sat 9-5"); // unchanged: no new version
    await fs.deleteFile("business/hours.md");
    expect(await fs.exists("business/hours.md")).toBe(false);
    const versions = await listNoteVersions(db, "business/hours.md");
    expect(versions.map((v) => [v.number, v.content, v.createdBy])).toEqual([
      [3, null, "agent:test"],
      [2, "Mon-Sat 9-5", "agent:test"],
      [1, "Mon-Fri 9-5", "agent:test"],
    ]);
    await restoreNoteVersion(db, "business/hours.md", 1, "user:u1");
    expect(await fs.readFile("business/hours.md", { encoding: "utf8" })).toBe("Mon-Fri 9-5");
    expect((await listNoteVersions(db, "business/hours.md"))[0]?.createdBy).toBe("user:u1");
  });

  it("moves and copies notes and folders", async () => {
    await fs.writeFile("inbox/hours.md", "Closed Sundays");
    await fs.moveFile("inbox/hours.md", "business/hours.md");
    expect(await fs.exists("inbox/hours.md")).toBe(false);
    await fs.writeFile("work/a/one.md", "1");
    await fs.copyFile("work/a", "work/b", { recursive: true });
    expect(await fs.readFile("work/b/one.md", { encoding: "utf8" })).toBe("1");
    await expect(fs.copyFile("work/a", "work/c")).rejects.toThrow();
    await expect(fs.moveFile("work", "sources/work")).rejects.toThrow("can't be moved");
  });

  it("removes folders only when asked to, and never the fixed ones", async () => {
    await fs.writeFile("work/a/one.md", "1");
    await expect(fs.rmdir("work/a")).rejects.toThrow();
    await fs.rmdir("work/a", { recursive: true });
    expect(await fs.exists("work/a")).toBe(false);
    await expect(fs.rmdir("work", { recursive: true })).rejects.toThrow("can't be removed");
    await expect(fs.mkdir("contacts")).rejects.toThrow("isn't a brain folder");
    await fs.mkdir("work/new");
  });

  it("refuses a write made against an older copy", async () => {
    await fs.writeFile("business/a.md", "one");
    const old = (await fs.stat("business/a.md")).modifiedAt;
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile("business/a.md", "two");
    await expect(fs.writeFile("business/a.md", "three", { expectedMtime: old })).rejects.toThrow();
    await expect(fs.writeFile("business/a.md", "x", { overwrite: false })).rejects.toThrow();
  });
});

describe("with Mastra's workspace tools", () => {
  it("the agent's file tools and keyword search work on the brain", async () => {
    const workspace = new Workspace({ id: "brain-test", filesystem: fs, bm25: true });
    await workspace.init();
    const tools = await createWorkspaceTools(workspace);
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining([
        "mastra_workspace_read_file",
        "mastra_workspace_write_file",
        "mastra_workspace_list_files",
        "mastra_workspace_search",
      ]),
    );
    const ctx = { workspace } as never;
    await tools.mastra_workspace_write_file.execute(
      { path: "/business/pricing.md", content: "# Pricing\n\nRoof repair from $450." },
      ctx,
    );
    const read = await tools.mastra_workspace_read_file.execute(
      { path: "/business/pricing.md" },
      ctx,
    );
    expect(JSON.stringify(read)).toContain("Roof repair from $450.");
    const listed = await tools.mastra_workspace_list_files.execute({ path: "/" }, ctx);
    expect(JSON.stringify(listed)).toContain("business");

    const edited = await tools.mastra_workspace_edit_file.execute(
      { path: "/business/pricing.md", old_string: "$450", new_string: "$475" },
      ctx,
    );
    expect(JSON.stringify(edited)).not.toContain("rror");
    const grep = await tools.mastra_workspace_grep.execute({ pattern: "\\$475", path: "/" }, ctx);
    expect(JSON.stringify(grep)).toContain("business/pricing.md");

    await workspace.index("/business/pricing.md", "Roof repair from $450.");
    const hits = await workspace.search("roof repair");
    expect(hits[0]?.id).toBe("/business/pricing.md");
  });
});

describe("summaries", () => {
  it("uses the first line of text, else the heading", () => {
    expect(summarize("# Title\n\nBody line")).toBe("Body line");
    expect(summarize("# Only a title")).toBe("Only a title");
    expect(buildIndex([])).toContain("(no notes yet)");
  });
});
