import { startSite } from "@locus/studio";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageGenerator } from "./images.ts";
import { type TestSession, testSession } from "./test-session.ts";
import { createSiteBuilderTools } from "./tools.ts";

let t: TestSession;
afterEach(() => t?.close());

async function setup(options: Parameters<typeof testSession>[0] = {}) {
  t = await testSession(options);
  const tools = createSiteBuilderTools({ resolve: async () => t.session });
  // Mastra calls execute(input, context); the tests do the same.
  const call = (name: keyof typeof tools, input: unknown = {}) =>
    // biome-ignore lint/suspicious/noExplicitAny: each tool has its own input type
    (tools[name].execute as any)(input, { requestContext: undefined }) as Promise<
      Record<string, unknown>
    >;
  return { tools, call };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const fakeImages: ImageGenerator = {
  generate: async () => ({ bytes: PNG, mediaType: "image/png", model: "image-test" }),
};

describe("file tools", () => {
  it("write, read, edit, list and delete", async () => {
    const { call } = await setup();
    expect(await call("write_file", { path: "./app/page.tsx", content: "a = 1" })).toEqual({
      written: "app/page.tsx",
    });
    expect(await call("edit_file", { path: "app/page.tsx", find: "1", replace: "2" })).toEqual({
      replacements: 1,
    });
    expect(await call("read_file", { path: "app/page.tsx" })).toEqual({
      path: "app/page.tsx",
      content: "a = 2",
    });
    expect(await call("list_files")).toEqual({ files: [{ path: "app/page.tsx", size: 5 }] });
    await call("delete_files", { paths: ["app/page.tsx"] });
    expect(await call("read_file", { path: "app/page.tsx" })).toEqual({
      error: "app/page.tsx doesn't exist.",
    });
  });

  it("returns refused paths as errors the model can fix", async () => {
    const { call } = await setup();
    expect(await call("write_file", { path: ".env", content: "KEY=1" })).toMatchObject({
      error: expect.stringContaining("Sites never contain .env"),
    });
    expect(await call("write_file", { path: "../x", content: "" })).toMatchObject({
      error: expect.stringContaining("leaves the site root"),
    });
  });
});

describe("sandbox tools", () => {
  it("check_site syncs the draft, installs and builds", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    expect(await call("check_site")).toEqual({ ok: true });
    const runtime = t.runtimes.runtimes.get("site-1");
    expect(runtime?.readText("app/page.tsx")).toContain("site.name");
    expect(runtime?.calls.some((c) => c.method === "install")).toBe(true);
    expect(runtime?.calls.find((c) => c.method === "run" && c.command === "npx")?.method).toBe(
      "run",
    );
    expect(t.usage).toEqual([{ kind: "sandbox", seconds: expect.any(Number) }]);
  });

  it("check_site reports build errors", async () => {
    const { call } = await setup({
      runtime: {
        handler: (command) =>
          command === "npx"
            ? { exitCode: 1, stdout: "Type error: Cannot find name 'Hero'.", stderr: "" }
            : undefined,
      },
    });
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    expect(await call("check_site")).toMatchObject({
      ok: false,
      step: "build",
      output: expect.stringContaining("Cannot find name 'Hero'"),
    });
  });

  it("sync deletes files the draft no longer has", async () => {
    const { call } = await setup({ runtime: { files: { "old.txt": "stale" } } });
    const runtime = await t.runtimes.open("site-1");
    runtime.handler = (command, _args, files) =>
      command === "find"
        ? { stdout: [...files.keys()].map((p) => `./${p}`).join("\n") }
        : undefined;
    await call("write_file", { path: "new.txt", content: "fresh" });
    await call("run_command", { command: "ls" });
    expect(runtime.files.has("old.txt")).toBe(false);
    expect(runtime.readText("new.txt")).toBe("fresh");
    // A second sync writes nothing new.
    const writes = runtime.calls.filter((c) => c.method === "writeFiles").length;
    await call("run_command", { command: "ls" });
    expect(runtime.calls.filter((c) => c.method === "writeFiles").length).toBe(writes);
  });

  it("preview returns the page URL and recent logs", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    (await t.runtimes.open("site-1")).setPreviewLogs("✓ Ready");
    expect(await call("preview", { path: "services" })).toEqual({
      ok: true,
      url: "https://preview.fake/services",
      recentLogs: "✓ Ready",
    });
  });

  it("refuses sandbox work when the client is out of credits", async () => {
    const { call } = await setup();
    t.meter.refuse = "This client has used its credits for this month.";
    expect(await call("run_command", { command: "ls" })).toEqual({
      error: "This client has used its credits for this month.",
    });
    expect(t.runtimes.runtimes.size).toBe(0);
  });

  it("fetches references from inside the sandbox", async () => {
    const { call } = await setup({
      runtime: {
        handler: (command) => (command === "node" ? { stdout: '{"title":"Ref"}' } : undefined),
      },
    });
    const result = await call("fetch_reference", { url: "https://example.com/" });
    expect(result).toMatchObject({ page: '{"title":"Ref"}' });
    const runtime = t.runtimes.runtimes.get("site-1");
    expect(runtime?.calls.find((c) => c.method === "run")).toMatchObject({
      command: "node",
      args: expect.arrayContaining(["https://example.com/"]),
    });
  });
});

describe("generate_image", () => {
  it("saves a PNG under public/ and meters it", async () => {
    const { call } = await setup({ images: fakeImages });
    expect(
      await call("generate_image", {
        prompt: "a bright dental office",
        path: "public/images/hero.png",
      }),
    ).toEqual({ saved: "public/images/hero.png", src: "/images/hero.png", bytes: PNG.byteLength });
    expect(await t.session.workspace.readFile("public/images/hero.png")).toEqual(PNG);
    expect(t.usage).toEqual([{ kind: "image", count: 1, size: "large", model: "image-test" }]);
  });

  it("refuses paths outside public/ and missing generators", async () => {
    const { call } = await setup({ images: fakeImages });
    expect(await call("generate_image", { prompt: "x x x", path: "app/hero.png" })).toMatchObject({
      error: expect.stringContaining("under public/"),
    });
    const other = await setup({ images: null });
    expect(
      await other.call("generate_image", { prompt: "x x x", path: "public/a.png" }),
    ).toMatchObject({ error: expect.stringContaining("isn't available") });
  });
});

describe("versions and brief", () => {
  it("saves a version and records the commit it was published as", async () => {
    const { call } = await setup();
    const published: string[] = [];
    t.session.onVersionSaved = async (version, files) => {
      published.push(`${version.number}:${files.length}`);
      return { commitSha: "abc123", url: "https://github.com/agency/site/commit/abc123" };
    };
    await call("write_file", { path: "a.txt", content: "one" });
    expect(await call("save_version", { message: "First page" })).toEqual({
      saved: true,
      version: 1,
      commitUrl: "https://github.com/agency/site/commit/abc123",
    });
    expect(published).toEqual(["1:1"]);
    expect((await t.session.workspace.latestVersion())?.commitSha).toBe("abc123");
    expect(await call("save_version", { message: "Again" })).toMatchObject({ saved: false });
  });

  it("keeps the version when publishing fails, and says why", async () => {
    const { call } = await setup();
    t.session.onVersionSaved = async () => {
      throw new Error("Connect GitHub on the Connections page first.");
    };
    await call("write_file", { path: "a.txt", content: "one" });
    expect(await call("save_version", { message: "First page" })).toEqual({
      saved: true,
      version: 1,
      publishError: "Connect GitHub on the Connections page first.",
    });
  });

  it("restores by version number", async () => {
    const { call } = await setup();
    await call("write_file", { path: "a.txt", content: "one" });
    await call("save_version", { message: "First" });
    await call("write_file", { path: "a.txt", content: "two" });
    await call("save_version", { message: "Second" });
    expect(await call("restore_version", { number: 1 })).toEqual({ restored: 1, nowVersion: 3 });
    expect(await t.session.workspace.readFile("a.txt")).toBe("one");
    expect(await call("restore_version", { number: 9 })).toEqual({
      error: "There's no version 9.",
    });
  });

  it("reads and updates the brief", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme", kind: "website" } });
    expect(await call("get_brief")).toMatchObject({ brief: expect.stringContaining("Name: Acme") });
    await call("update_brief", { goal: "Book a call", palette: { primary: "#112233" } });
    const after = await call("get_brief");
    expect(after.brief).toContain("Visitor goal: Book a call");
    expect(after.brief).toContain("primary #112233");
    expect(await call("update_brief", { palette: { primary: "red" } })).toHaveProperty("error");
  });
});
