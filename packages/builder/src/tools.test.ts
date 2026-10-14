import { startSite } from "@locus/studio";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageGenerator } from "./images.ts";
import { type TestSession, testSession } from "./test-session.ts";
import { createSiteBuilderTools, PublishError } from "./tools.ts";

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
  it("every tool decides its own approval, and never asks for one", async () => {
    const { tools } = await setup();
    for (const [name, tool] of Object.entries(tools)) {
      expect(typeof tool.requireApproval, name).toBe("function");
      // biome-ignore lint/suspicious/noExplicitAny: the predicate's input differs per tool
      expect(await (tool.requireApproval as any)({}), name).toBe(false);
    }
  });

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

  it("sync deletes files the draft no longer has, and skips what already matches", async () => {
    const { call } = await setup({ runtime: { files: { "old.txt": "stale" } } });
    const runtime = await t.runtimes.open("site-1");
    await call("write_file", { path: "new.txt", content: "fresh" });
    await call("run_command", { command: "ls" });
    expect(runtime.files.has("old.txt")).toBe(false);
    expect(runtime.readText("new.txt")).toBe("fresh");
    // A second sync writes nothing new.
    const writes = runtime.calls.filter((c) => c.method === "writeFiles").length;
    await call("run_command", { command: "ls" });
    expect(runtime.calls.filter((c) => c.method === "writeFiles").length).toBe(writes);
  });

  it("a sandbox recreated empty behind the same runtime gets every file again", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    await call("run_command", { command: "ls" });
    const runtime = await t.runtimes.open("site-1");
    const count = runtime.files.size;
    expect(count).toBeGreaterThan(3);
    // The provider replaced the sandbox: same object, nothing in it.
    runtime.files.clear();
    await call("run_command", { command: "ls" });
    expect(runtime.files.size).toBe(count);
    expect(runtime.readText("app/page.tsx")).toContain("site.name");
  });

  it("a file changed inside the sandbox is put back to the draft's", async () => {
    const { call } = await setup();
    await call("write_file", { path: "a.txt", content: "draft" });
    await call("run_command", { command: "ls" });
    const runtime = await t.runtimes.open("site-1");
    runtime.files.set("a.txt", "changed by a command");
    await call("run_command", { command: "ls" });
    expect(runtime.readText("a.txt")).toBe("draft");
  });

  it("never deletes lockfiles or files the build makes", async () => {
    const { call } = await setup({
      runtime: {
        files: {
          "pnpm-lock.yaml": "lock",
          "package-lock.json": "{}",
          "next-env.d.ts": "/// <reference types='next' />",
          "tsconfig.tsbuildinfo": "{}",
          "stray.txt": "x",
          ".locus/seeded": "1",
        },
      },
    });
    await call("write_file", { path: "a.txt", content: "a" });
    await call("run_command", { command: "ls" });
    const runtime = await t.runtimes.open("site-1");
    expect([...runtime.files.keys()].sort()).toEqual([
      ".locus/seeded",
      "a.txt",
      "next-env.d.ts",
      "package-lock.json",
      "pnpm-lock.yaml",
      "tsconfig.tsbuildinfo",
    ]);
  });

  it("run_command refuses to change packages and points to add_dependency", async () => {
    const { call } = await setup();
    for (const [command, args] of [
      ["npm", ["install", "lodash"]],
      ["npm", ["i", "-D", "lodash"]],
      ["pnpm", ["add", "lodash"]],
      ["/usr/bin/yarn", ["add", "lodash"]],
      ["npm", ["uninstall", "next"]],
      ["pnpm", ["update"]],
    ] as const) {
      expect(await call("run_command", { command, args }), `${command} ${args}`).toMatchObject({
        error: expect.stringContaining("add_dependency"),
      });
    }
    expect(t.runtimes.runtimes.size).toBe(0);
    // A plain install is fine.
    expect(await call("run_command", { command: "npm", args: ["install"] })).toMatchObject({
      exitCode: 0,
    });
  });

  it("puts package.json back when a command changed it some other way", async () => {
    const { call } = await setup({
      runtime: {
        handler: (command, _args, files) => {
          if (command !== "sh") return undefined;
          (files as Map<string, string>).set("package.json", '{"dependencies":{"left-pad":"1"}}');
          return { stdout: "added 1 package" };
        },
      },
    });
    await call("write_file", { path: "package.json", content: '{"dependencies":{}}' });
    const result = await call("run_command", { command: "sh", args: ["-c", "npm i left-pad"] });
    expect(result).toMatchObject({ exitCode: 0, note: expect.stringContaining("add_dependency") });
    const runtime = await t.runtimes.open("site-1");
    expect(runtime.readText("package.json")).toBe('{"dependencies":{}}');
    // A command that leaves package.json alone gets no note.
    expect(await call("run_command", { command: "ls" })).not.toHaveProperty("note");
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

  it("keeps preview pages on the preview's origin", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    expect(await call("preview", { path: "\\\\evil.com" })).toMatchObject({
      url: "https://preview.fake/evil.com",
    });
    expect(await call("preview", { path: "/\\/evil.com/x" })).toMatchObject({
      url: "https://preview.fake/evil.com/x",
    });
    expect(await call("preview", { path: "/\t/evil.com" })).toMatchObject({
      error: expect.stringContaining("page path"),
    });
  });

  it("a meter that fails while recording doesn't hide why the work failed", async () => {
    const { call } = await setup({
      runtime: {
        handler: (command) => {
          if (command === "explode") throw new Error("sandbox went away");
          return undefined;
        },
      },
    });
    t.meter.record = async () => {
      throw new Error("meter down");
    };
    await expect(call("run_command", { command: "explode" })).rejects.toThrow("sandbox went away");
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

describe("add_dependency", () => {
  const npm = (versions: Record<string, string>) => ({
    handler: (command: string, args: string[]) => {
      if (command !== "npm" || args[0] !== "view") return undefined;
      const name = args[args.indexOf("--") + 1] ?? "";
      const version = versions[name];
      return version ? { stdout: `${version}\n` } : { exitCode: 1, stderr: "E404" };
    },
  });

  it("pins the current version in the draft and installs it", async () => {
    const { call } = await setup({
      runtime: npm({ zod: "4.1.0", "@radix-ui/react-dialog": "1.1.2" }),
    });
    await call("write_file", {
      path: "package.json",
      content: '{"name":"site","dependencies":{"next":"16.0.0"}}',
    });
    expect(await call("add_dependency", { name: "zod" })).toEqual({
      added: "zod@4.1.0",
      installed: true,
    });
    expect(await call("add_dependency", { name: "@radix-ui/react-dialog", dev: true })).toEqual({
      added: "@radix-ui/react-dialog@1.1.2",
      installed: true,
    });
    const pkg = JSON.parse((await t.session.workspace.readFile("package.json")) as string);
    expect(pkg.dependencies).toEqual({ next: "16.0.0", zod: "4.1.0" });
    expect(pkg.devDependencies).toEqual({ "@radix-ui/react-dialog": "1.1.2" });
    const runtime = t.runtimes.runtimes.get("site-1");
    // The name always follows `--`, so npm can't read it as an option.
    expect(runtime?.calls.find((c) => c.method === "run" && c.command === "npm")).toMatchObject({
      args: ["view", "--", "zod", "version"],
    });
    expect(runtime?.readText("package.json")).toContain('"zod": "4.1.0"');
    expect(runtime?.calls.some((c) => c.method === "install")).toBe(true);
  });

  it.each([
    "--json",
    "-g",
    "--registry=https://evil.example",
    "Zod",
    "a b",
    ".hidden",
    "_private",
    "@-scope/x",
    "@scope/-x",
    "zod@latest",
    "a;rm -rf /",
  ])("refuses the name %j", async (name) => {
    // npm would "find" anything; the name must be refused before it is asked.
    const { call } = await setup({ runtime: { handler: () => ({ stdout: "1.0.0" }) } });
    await call("write_file", { path: "package.json", content: "{}" });
    expect(await call("add_dependency", { name })).toHaveProperty("error");
    expect(await t.session.workspace.readFile("package.json")).toBe("{}");
    expect(t.runtimes.runtimes.size).toBe(0);
  });

  it("says when npm has no such package, or package.json is broken", async () => {
    const { call } = await setup({ runtime: npm({ zod: "4.1.0" }) });
    await call("write_file", { path: "package.json", content: "{}" });
    expect(await call("add_dependency", { name: "no-such-pkg" })).toEqual({
      error: "npm has no package called no-such-pkg.",
    });
    await call("write_file", { path: "package.json", content: "{ nope" });
    expect(await call("add_dependency", { name: "zod" })).toMatchObject({
      error: expect.stringContaining("package.json isn't valid JSON"),
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

  it("doesn't pass off other errors as invalid JSON", async () => {
    const { call } = await setup({
      images: {
        generate: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      },
    });
    await expect(
      call("generate_image", { prompt: "a bright office", path: "public/a.png" }),
    ).rejects.toThrow(SyntaxError);
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

  it("keeps the version when publishing fails, and says why in the person's words", async () => {
    const { call } = await setup();
    t.session.onVersionSaved = async () => {
      throw new PublishError("Connect GitHub on the Connections page first.");
    };
    await call("write_file", { path: "a.txt", content: "one" });
    expect(await call("save_version", { message: "First page" })).toEqual({
      saved: true,
      version: 1,
      publishError: "Connect GitHub on the Connections page first.",
    });
  });

  it("never passes a git host's raw error text to the model", async () => {
    const { call } = await setup();
    t.session.onVersionSaved = async () => {
      throw new Error("HttpError: Bad credentials - https://docs.github.com/rest (token ghs_x)");
    };
    await call("write_file", { path: "a.txt", content: "one" });
    const result = await call("save_version", { message: "First page" });
    expect(result).toMatchObject({ saved: true, version: 1 });
    expect(JSON.stringify(result)).not.toMatch(/Bad credentials|ghs_|github\.com/);
    expect(result.publishError).toContain("couldn't be published");
  });

  it("a published version whose commit can't be recorded isn't a publish error", async () => {
    const { call } = await setup();
    t.session.onVersionSaved = async () => ({
      commitSha: "abc123",
      url: "https://github.com/agency/site/commit/abc123",
    });
    t.session.workspace.setCommitSha = async () => {
      throw new Error("SQLITE_BUSY");
    };
    await call("write_file", { path: "a.txt", content: "one" });
    const result = await call("save_version", { message: "First page" });
    expect(result).toEqual({
      saved: true,
      version: 1,
      commitUrl: "https://github.com/agency/site/commit/abc123",
      note: "Published, but the commit couldn't be linked to the version.",
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

describe("releasing the session", () => {
  it("releases once after every call, including ones that fail", async () => {
    t = await testSession();
    let released = 0;
    const tools = createSiteBuilderTools({
      resolve: async () => ({ ...t.session, release: () => void released++ }),
    });
    const call = (name: keyof typeof tools, input: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: each tool has its own input type
      (tools[name].execute as any)(input, {});
    await call("write_file", { path: "a.txt", content: "one" });
    expect(released).toBe(1);
    expect(await call("read_file", { path: "missing.txt" })).toHaveProperty("error");
    expect(released).toBe(2);
  });
});
