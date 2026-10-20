import { CrmMediaError, type SiteCrm, siteCrm, siteImagesFolderName } from "@locus/connect";
import { startSite } from "@locus/studio";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerator } from "./images.ts";
import { type TestSession, testSession } from "./test-session.ts";
import { createSiteBuilderTools, MEDIA_LIBRARY_TIMEOUT_MS, PublishError } from "./tools.ts";

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
    expect(
      await call("files", { action: "write", path: "./app/page.tsx", content: "a = 1" }),
    ).toEqual({
      written: "app/page.tsx",
    });
    expect(
      await call("files", { action: "edit", path: "app/page.tsx", find: "1", replace: "2" }),
    ).toEqual({
      replacements: 1,
    });
    expect(await call("files", { action: "read", path: "app/page.tsx" })).toEqual({
      path: "app/page.tsx",
      content: "a = 2",
    });
    expect(await call("files", { action: "list" })).toEqual({
      files: [{ path: "app/page.tsx", size: 5 }],
    });
    await call("files", { action: "delete", paths: ["app/page.tsx"] });
    expect(await call("files", { action: "read", path: "app/page.tsx" })).toEqual({
      error: "app/page.tsx doesn't exist.",
    });
  });

  it("returns refused paths as errors the model can fix", async () => {
    const { call } = await setup();
    expect(await call("files", { action: "write", path: ".env", content: "KEY=1" })).toMatchObject({
      error: expect.stringContaining("Sites never contain .env"),
    });
    expect(await call("files", { action: "write", path: "../x", content: "" })).toMatchObject({
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

  it("check_site lists what search results would show badly once it builds", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    await call("files", {
      action: "write",
      path: "app/pricing/page.tsx",
      content: "export default function Pricing() { return null; }",
    });
    expect(await call("check_site")).toEqual({
      ok: true,
      seo: [
        { page: "/pricing", problem: "No title in the page's metadata." },
        { page: "/pricing", problem: "No description in the page's metadata." },
        { page: "/pricing", problem: expect.stringContaining("No canonical address") },
      ],
    });
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
    await call("files", { action: "write", path: "new.txt", content: "fresh" });
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
    await call("files", { action: "write", path: "a.txt", content: "draft" });
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
    await call("files", { action: "write", path: "a.txt", content: "a" });
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
    for (const [command, args] of [
      ["npx", ["shadcn@latest", "add", "dialog"]],
      ["npx", ["-y", "shadcn", "add", "dialog"]],
      ["pnpm", ["dlx", "shadcn@latest", "add", "dialog"]],
      ["pnpm", ["exec", "shadcn", "init"]],
      ["bunx", ["shadcn", "add", "tabs"]],
      ["yarn", ["dlx", "shadcn", "add", "tabs"]],
    ] as const) {
      expect(await call("run_command", { command, args }), `${command} ${args}`).toMatchObject({
        error: expect.stringContaining("add_dependency({ component"),
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
    await call("files", { action: "write", path: "package.json", content: '{"dependencies":{}}' });
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

  describe("the site's database", () => {
    const answers = (status: number, body: unknown) => (command: string, args: string[]) =>
      command === "node" && args.join(" ").includes("preview-migrations")
        ? { stdout: JSON.stringify({ status, body: JSON.stringify(body) }) }
        : undefined;

    it("makes the site app-style once, keeping what it already has", async () => {
      const { call } = await setup();
      await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
      const first = await call("database", { action: "add" });
      expect(first.changed).toEqual(
        expect.arrayContaining([
          "package.json",
          "db/schema.ts",
          "db/migrations/0000_logins.sql",
          "lib/auth.ts",
        ]),
      );
      const pkg = JSON.parse(String(await t.session.workspace.readFile("package.json")));
      expect(pkg.dependencies["better-auth"]).toBe("1.7.7");
      await t.session.workspace.writeFile("db/schema.ts", "// grown by the agent");
      expect(await call("database", { action: "add" })).toMatchObject({ changed: [] });
      expect(await t.session.workspace.readFile("db/schema.ts")).toBe("// grown by the agent");

      // An older version of the uploads is replaced, and its retired route deleted.
      await t.session.workspace.writeFile("lib/files.ts", "// old uploads");
      await t.session.workspace.writeFile("app/api/files/[action]/route.ts", "// old route");
      const renewed = await call("database", { action: "add" });
      expect(renewed).toMatchObject({
        changed: ["lib/files.ts"],
        removed: ["app/api/files/[action]/route.ts"],
      });
      expect(renewed.next).toContain("{ fileId, url }");
      expect(await t.session.workspace.readFile("lib/files.ts")).toContain("keepFile");
      expect((await t.session.workspace.snapshot()).map((f) => f.path)).not.toContain(
        "app/api/files/[action]/route.ts",
      );
    });

    it("applies migrations to the preview's database, and preview does it too", async () => {
      const { call } = await setup({
        runtime: { handler: answers(200, { applied: ["0001_bookings"] }) },
      });
      await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
      expect(await call("database", { action: "apply" })).toEqual({
        error: "This site has no database yet: use database add first.",
      });
      await call("database", { action: "add" });
      expect(await call("database", { action: "apply" })).toEqual({ applied: ["0001_bookings"] });
      expect(await call("preview")).toMatchObject({
        ok: true,
        database: { applied: ["0001_bookings"] },
      });
    });

    it("reports a migration the preview refused, and a badly named one before running", async () => {
      const { call } = await setup({
        runtime: { handler: answers(422, { error: 'SQLITE_ERROR: near "tabel"' }) },
      });
      await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
      await call("database", { action: "add" });
      expect(await call("database", { action: "apply" })).toEqual({
        error: 'A migration failed in the preview: SQLITE_ERROR: near "tabel"',
      });
      await t.session.workspace.writeFile("db/migrations/bookings.sql", "select 1");
      expect(await call("database", { action: "apply" })).toEqual({
        error: expect.stringContaining("isn't named like db/migrations/0001_short_name.sql"),
      });
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
    await call("files", {
      action: "write",
      path: "package.json",
      content: '{"name":"site","dependencies":{"next":"16.0.0"}}',
    });
    expect(await call("add_dependency", { package: "zod" })).toEqual({
      added: "zod@4.1.0",
      installed: true,
    });
    expect(await call("add_dependency", { package: "@radix-ui/react-dialog", dev: true })).toEqual({
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
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { package: name })).toHaveProperty("error");
    expect(await t.session.workspace.readFile("package.json")).toBe("{}");
    expect(t.runtimes.runtimes.size).toBe(0);
  });

  it("says when npm has no such package, or package.json is broken", async () => {
    const { call } = await setup({ runtime: npm({ zod: "4.1.0" }) });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { package: "no-such-pkg" })).toEqual({
      error: "npm has no package called no-such-pkg.",
    });
    await call("files", { action: "write", path: "package.json", content: "{ nope" });
    expect(await call("add_dependency", { package: "zod" })).toMatchObject({
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

describe("generate_image and the client's Media Library", () => {
  // Level 1: the builder's real CRM over a fake GHL, so the requests are the ones GHL would get.
  const GHL_LOCATION = "ghl-loc-sunrise";
  const storeUrl = (name: string) =>
    `https://storage.googleapis.com/msgsndr/${GHL_LOCATION}/media/${name}`;
  let fake: FakeGhl;
  let library: { _id: string; type: string; name: string; parentId?: string; url?: string }[];
  const routes = (over: FakeRoutes = {}): FakeRoutes => ({
    "GET /medias/files": (req) => {
      const q = req.url.searchParams;
      return {
        body: {
          files: library.filter(
            (f) => f.type === q.get("type") && (!q.get("query") || f.name === q.get("query")),
          ),
        },
      };
    },
    "POST /medias/folder": (req) => {
      const folder = { _id: `folder${library.length}`, type: "folder", name: "" };
      folder.name = (req.body as { name: string }).name;
      library.push(folder);
      return { body: folder };
    },
    "POST /medias/upload-file": (req) => {
      const form = req.body as FormData;
      const id = `file${library.length}`;
      const name = String(form.get("name"));
      library.push({
        _id: id,
        type: "file",
        name,
        parentId: String(form.get("parentId")),
        url: storeUrl(name),
      });
      return { body: { fileId: id, url: storeUrl(name) } };
    },
    ...over,
  });
  const connect = (scopes: string[], over?: FakeRoutes) => {
    library = [];
    fake = createFakeGhl(routes(over));
    t.session.crm = siteCrm(async () => ({
      session: async () => ({
        token: "location-token",
        tokenKind: "location",
        locationId: GHL_LOCATION,
      }),
      http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
      scopes,
    }));
  };
  const generate = (call: (name: "generate_image", input: unknown) => Promise<unknown>) =>
    call("generate_image", { prompt: "a bright dental office", path: "public/images/hero.png" });

  it("keeps a copy in the site's own folder of the Media Library, and reuses that folder", async () => {
    const { call } = await setup({ images: fakeImages });
    connect(["medias.readonly", "medias.write"]);
    expect(await generate(call)).toEqual({
      saved: "public/images/hero.png",
      src: "/images/hero.png",
      bytes: PNG.byteLength,
      mediaLibrary: "A copy is in the client's Media Library too.",
    });
    // The site keeps its own copy and still serves it itself.
    expect(await t.session.workspace.readFile("public/images/hero.png")).toEqual(PNG);

    expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /medias/files",
      "POST /medias/folder",
      "GET /medias/files",
      "POST /medias/upload-file",
    ]);
    const [find, make, older, upload] = fake.requests;
    expect(find?.url.searchParams.get("type")).toBe("folder");
    expect(find?.url.searchParams.get("query")).toBe(siteImagesFolderName("site-1"));
    expect(find?.url.searchParams.get("altId")).toBe(GHL_LOCATION);
    // Any earlier copy of hero.png in that folder, to replace.
    expect(older?.url.searchParams.get("type")).toBe("file");
    expect(older?.url.searchParams.get("parentId")).toBe("folder0");
    expect(older?.url.searchParams.get("query")).toBe("hero.png");
    expect(make?.body).toMatchObject({
      name: "Site images site-1",
      altId: GHL_LOCATION,
      altType: "location",
    });
    expect(upload?.headers.version).toBe("v3");
    const form = upload?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("name")).toBe("hero.png");
    expect(form.get("parentId")).toBe("folder0");
    const file = form.get("file") as File;
    expect(file.name).toBe("hero.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    // The next image goes into the same folder; no second folder is made.
    fake.requests.length = 0;
    expect(
      await call("generate_image", { prompt: "a smiling team", path: "public/images/team.png" }),
    ).toMatchObject({ mediaLibrary: expect.any(String) });
    expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /medias/files",
      "GET /medias/files",
      "POST /medias/upload-file",
    ]);
    expect((fake.requests[2]?.body as FormData | undefined)?.get("parentId")).toBe("folder0");
    expect(library.filter((f) => f.type === "folder")).toHaveLength(1);
  });

  it("replaces the copy kept before when the same image is made again", async () => {
    const { call } = await setup({ images: fakeImages });
    connect(["medias.write"], {
      "*": (req) => {
        const id = /^\/medias\/([A-Za-z0-9]+)$/.exec(req.url.pathname)?.[1];
        if (req.method !== "DELETE" || !id) return { status: 404, body: { message: "no" } };
        library = library.filter((f) => f._id !== id);
        return { body: {} };
      },
    });
    await generate(call);
    await generate(call);
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.url.pathname)).toEqual([
      "/medias/file1",
    ]);
    expect(library.map((f) => `${f._id} ${f.name}`)).toEqual([
      "folder0 Site images site-1",
      "file2 hero.png",
    ]);
  });

  it("answers without the Media Library when GHL doesn't answer in time", async () => {
    const { call } = await setup({ images: fakeImages });
    let asked!: () => void;
    const saving = new Promise<void>((resolve) => {
      asked = resolve;
    });
    t.session.crm = fakeCrm({
      saveImage: () => {
        asked();
        return new Promise(() => {});
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = generate(call);
      await saving;
      await vi.advanceTimersByTimeAsync(MEDIA_LIBRARY_TIMEOUT_MS);
      expect(await result).toEqual({
        saved: "public/images/hero.png",
        src: "/images/hero.png",
        bytes: PNG.byteLength,
        note: "The image is in the site, but it wasn't saved to the client's Media Library. The Media Library couldn't be reached just now.",
      });
    } finally {
      vi.useRealTimers();
      errors.mockRestore();
    }
    expect(await t.session.workspace.readFile("public/images/hero.png")).toEqual(PNG);
  });

  it("asks nothing of GHL when the connection may not write to the Media Library", async () => {
    const { call } = await setup({ images: fakeImages });
    connect(["medias.readonly"]);
    expect(await generate(call)).toEqual({
      saved: "public/images/hero.png",
      src: "/images/hero.png",
      bytes: PNG.byteLength,
      note: expect.stringMatching(
        /^The image is in the site, but it wasn't saved to the client's Media Library\. .*isn't allowed/,
      ),
    });
    expect(fake.requests).toEqual([]);
    expect(await t.session.workspace.readFile("public/images/hero.png")).toEqual(PNG);
  });

  it("still saves the image into the site when GHL fails", async () => {
    const { call } = await setup({ images: fakeImages });
    connect(["medias.write"], {
      "POST /medias/upload-file": { status: 500, body: { statusCode: 500, message: "boom" } },
    });
    expect(await generate(call)).toEqual({
      saved: "public/images/hero.png",
      src: "/images/hero.png",
      bytes: PNG.byteLength,
      note: "The image is in the site, but it wasn't saved to the client's Media Library. The Media Library couldn't be reached just now.",
    });
    expect(fake.requests.at(-1)?.url.pathname).toBe("/medias/upload-file");
    expect(await t.session.workspace.readFile("public/images/hero.png")).toEqual(PNG);
    expect(t.usage).toHaveLength(1);
  });
});

describe("view_reference", () => {
  it("shows the model a screenshot the brief lists, as a picture", async () => {
    const { tools, call } = await setup();
    await startSite(t.session.workspace, {
      brief: {
        name: "Acme",
        references: [{ kind: "screenshot", path: "design/references/screenshot-1.png" }],
      },
      templateId: "blank",
      files: [{ path: "design/references/screenshot-1.png", content: PNG }],
    });
    const output = await call("view_reference", { path: "./design/references/screenshot-1.png" });
    expect(output).toEqual({
      path: "design/references/screenshot-1.png",
      mediaType: "image/png",
      data: Buffer.from(PNG).toString("base64"),
    });
    expect(tools.view_reference.toModelOutput?.(output)).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Reference screenshot design/references/screenshot-1.png:" },
        { type: "image-data", data: Buffer.from(PNG).toString("base64"), mediaType: "image/png" },
      ],
    });
  });

  it("refuses files the brief doesn't list as screenshots", async () => {
    const { tools, call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme" }, templateId: "blank" });
    await t.session.workspace.writeFile("public/a.png", PNG);
    const output = await call("view_reference", { path: "public/a.png" });
    expect(output).toEqual({ error: expect.stringContaining("isn't a screenshot in the brief") });
    expect(tools.view_reference.toModelOutput?.(output)).toEqual({ type: "json", value: output });
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
    await call("files", { action: "write", path: "a.txt", content: "one" });
    expect(await call("versions", { action: "save", message: "First page" })).toEqual({
      saved: true,
      version: 1,
      commitUrl: "https://github.com/agency/site/commit/abc123",
    });
    expect(published).toEqual(["1:1"]);
    expect((await t.session.workspace.latestVersion())?.commitSha).toBe("abc123");
    expect(await call("versions", { action: "save", message: "Again" })).toMatchObject({
      saved: false,
    });
  });

  it("keeps the version when publishing fails, and says why in the person's words", async () => {
    const { call } = await setup();
    t.session.onVersionSaved = async () => {
      throw new PublishError("Connect GitHub on the Connections page first.");
    };
    await call("files", { action: "write", path: "a.txt", content: "one" });
    expect(await call("versions", { action: "save", message: "First page" })).toEqual({
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
    await call("files", { action: "write", path: "a.txt", content: "one" });
    const result = await call("versions", { action: "save", message: "First page" });
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
    await call("files", { action: "write", path: "a.txt", content: "one" });
    const result = await call("versions", { action: "save", message: "First page" });
    expect(result).toEqual({
      saved: true,
      version: 1,
      commitUrl: "https://github.com/agency/site/commit/abc123",
      note: "Published, but the commit couldn't be linked to the version.",
    });
  });

  it("restores by version number", async () => {
    const { call } = await setup();
    await call("files", { action: "write", path: "a.txt", content: "one" });
    await call("versions", { action: "save", message: "First" });
    await call("files", { action: "write", path: "a.txt", content: "two" });
    await call("versions", { action: "save", message: "Second" });
    expect(await call("versions", { action: "restore", number: 1 })).toEqual({
      restored: 1,
      nowVersion: 3,
    });
    expect(await t.session.workspace.readFile("a.txt")).toBe("one");
    expect(await call("versions", { action: "restore", number: 9 })).toEqual({
      error: "There's no version 9.",
    });
  });

  it("reads and updates the brief", async () => {
    const { call } = await setup();
    await startSite(t.session.workspace, { brief: { name: "Acme", kind: "website" } });
    expect(await call("brief")).toMatchObject({ brief: expect.stringContaining("Name: Acme") });
    await call("brief", { changes: { goal: "Book a call", palette: { primary: "#112233" } } });
    const after = await call("brief");
    expect(after.brief).toContain("Visitor goal: Book a call");
    expect(after.brief).toContain("primary #112233");
    expect(await call("brief", { changes: { palette: { primary: "red" } } })).toHaveProperty(
      "error",
    );
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
    await call("files", { action: "write", path: "a.txt", content: "one" });
    expect(released).toBe(1);
    expect(await call("files", { action: "read", path: "missing.txt" })).toHaveProperty("error");
    expect(released).toBe(2);
  });
});

describe("consolidated tools", () => {
  it("say which field an action is missing", async () => {
    const { call } = await setup();
    expect(await call("files", { action: "write", path: "a.txt" })).toEqual({
      error: "write needs the file's content.",
    });
    expect(await call("files", { action: "read" })).toEqual({ error: "read needs a path." });
    expect(await call("versions", { action: "restore" })).toEqual({
      error: "restore needs a version number.",
    });
    expect(await call("add_dependency", {})).toEqual({
      error: "Pass either package or component.",
    });
  });

  it("lists versions and reads preview logs without starting a preview", async () => {
    const { call } = await setup();
    await call("files", { action: "write", path: "a.txt", content: "one" });
    await call("versions", { action: "save", message: "First" });
    expect(await call("versions", { action: "list" })).toMatchObject({
      versions: [{ number: 1, message: "First", source: "agent" }],
    });
    (await t.runtimes.open("site-1")).setPreviewLogs("✓ Ready");
    expect(await call("preview", { logs: true })).toEqual({ logs: "✓ Ready" });
    expect(t.usage).toEqual([]);
  });
});

describe("add_dependency with a component", () => {
  const item = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name,
      type: "registry:ui",
      files: [
        {
          path: `registry/new-york-v4/ui/${name}.tsx`,
          type: "registry:ui",
          content: `import { Button } from "@/registry/new-york-v4/ui/button"\nexport const ${name.replace("-", "")} = 1\n`,
        },
      ],
      ...extra,
    });

  /** A sandbox where node fetches registry items from `items` (by URL) and npm knows `versions`. */
  const registry = (items: Record<string, string>, versions: Record<string, string> = {}) => ({
    handler: (command: string, args: string[]) => {
      if (command === "node") {
        const url = args.at(-1) ?? "";
        const body = items[url];
        return body === undefined ? { exitCode: 2, stderr: "HTTP 404" } : { stdout: body };
      }
      if (command === "npm" && args[0] === "view") {
        const version = versions[args[args.indexOf("--") + 1] ?? ""];
        return version ? { stdout: `${version}\n` } : { exitCode: 1, stderr: "E404" };
      }
      return undefined;
    },
  });
  const official = (name: string) => `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`;

  it("writes the component and the ones it needs, rewrites imports, and pins its packages", async () => {
    const { call } = await setup({
      runtime: registry(
        {
          [official("dialog")]: item("dialog", {
            dependencies: ["radix-ui", "@floating-ui/react@^0.27"],
            registryDependencies: ["button", "utils"],
            cssVars: { light: { overlay: "#000" } },
          }),
          [official("button")]: item("button"),
          [official("utils")]: JSON.stringify({
            name: "utils",
            type: "registry:lib",
            files: [
              { path: "registry/new-york-v4/lib/utils.ts", type: "registry:lib", content: "x" },
            ],
          }),
        },
        { "@floating-ui/react": "0.27.5" },
      ),
    });
    await call("files", {
      action: "write",
      path: "package.json",
      content: '{"dependencies":{"radix-ui":"1.8.1"}}',
    });
    await call("files", { action: "write", path: "lib/utils.ts", content: "mine" });
    const result = await call("add_dependency", { component: "dialog" });
    expect(result).toMatchObject({
      added: ["dialog", "button", "utils"],
      files: ["components/ui/dialog.tsx", "components/ui/button.tsx"],
      contents: expect.stringContaining(
        '--- components/ui/dialog.tsx ---\nimport { Button } from "@/components/ui/button"',
      ),
      kept: ["lib/utils.ts"],
      packages: ["@floating-ui/react@0.27.5"],
      installed: true,
      theme: expect.stringContaining("overlay"),
    });
    const dialog = (await t.session.workspace.readFile("components/ui/dialog.tsx")) as string;
    expect(dialog).toContain('from "@/components/ui/button"');
    expect(await t.session.workspace.readFile("lib/utils.ts")).toBe("mine");
    const pkg = JSON.parse((await t.session.workspace.readFile("package.json")) as string);
    expect(pkg.dependencies).toEqual({ "@floating-ui/react": "0.27.5", "radix-ui": "1.8.1" });
    // Fetched inside the sandbox, never by Locus's servers.
    const runtime = t.runtimes.runtimes.get("site-1");
    expect(runtime?.calls.filter((c) => c.method === "run" && c.command === "node")).toHaveLength(
      3,
    );
    expect(t.usage).toEqual([{ kind: "sandbox", seconds: expect.any(Number) }]);
  });

  it("keeps a component the site already has unless told to overwrite it", async () => {
    const { call } = await setup({ runtime: registry({ [official("badge")]: item("badge") }) });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    await call("files", { action: "write", path: "components/ui/badge.tsx", content: "edited" });
    expect(await call("add_dependency", { component: "badge" })).toMatchObject({
      files: [],
      kept: ["components/ui/badge.tsx"],
    });
    expect(await call("add_dependency", { component: "badge", overwrite: true })).toMatchObject({
      files: ["components/ui/badge.tsx"],
    });
    expect(await t.session.workspace.readFile("components/ui/badge.tsx")).toContain("badge = 1");
  });

  it("takes another registry's item by https URL", async () => {
    const url = "https://registry.example.com/r/pricing-table.json";
    const { call } = await setup({ runtime: registry({ [url]: item("pricing-table") }) });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: url })).toMatchObject({
      added: ["pricing-table"],
      files: ["components/ui/pricing-table.tsx"],
    });
  });

  it.each([
    ["http://registry.example.com/x.json", "plain https address"],
    ["https://user:pw@registry.example.com/x.json", "plain https address"],
    ["Dialog Box", "isn't a component name"],
  ])("refuses %j", async (component, message) => {
    const { call } = await setup({ runtime: registry({}) });
    expect(await call("add_dependency", { component })).toEqual({
      error: expect.stringContaining(message),
    });
  });

  it("says when an item can't be read or isn't a registry item", async () => {
    const { call } = await setup({
      runtime: registry({
        [official("weird")]: '{"hello":1}',
        [official("broken")]: "<html>",
        [official("bad-dep")]: item("bad-dep", { dependencies: ["Not A Package"] }),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: "missing" })).toEqual({
      error: expect.stringContaining("couldn't be read: HTTP 404"),
    });
    expect(await call("add_dependency", { component: "weird" })).toEqual({
      error: expect.stringContaining("isn't a registry item"),
    });
    expect(await call("add_dependency", { component: "broken" })).toEqual({
      error: expect.stringContaining("not JSON"),
    });
    expect(await call("add_dependency", { component: "bad-dep" })).toEqual({
      error: expect.stringContaining("isn't an npm package name"),
    });
  });

  it("refuses a file a registry tries to put outside the site or in .env", async () => {
    const { call } = await setup({
      runtime: registry({
        [official("sneaky")]: JSON.stringify({
          name: "sneaky",
          files: [{ path: "x", type: "registry:file", target: "../../etc/passwd", content: "x" }],
        }),
        [official("env")]: JSON.stringify({
          name: "env",
          files: [{ path: "x", type: "registry:file", target: ".env", content: "KEY=1" }],
        }),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: "sneaky" })).toHaveProperty("error");
    expect(await call("add_dependency", { component: "env" })).toHaveProperty("error");
    expect((await t.session.workspace.listFiles()).map((f) => f.path)).toEqual(["package.json"]);
  });

  /** An item with one file at `target` (and any extra fields). */
  const targeted = (name: string, target: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name,
      files: [{ path: `x/${name}.tsx`, type: "registry:file", target, content: "x" }],
      ...extra,
    });

  it.each([
    ["root-file.ts", "only go under"],
    ["package.json", "only go under"],
    ["next.config.mjs", "only go under"],
    ["middleware.ts", "only go under"],
    ["components/tsconfig.json", "never be configuration"],
    ["lib/postcss.config.mjs", "never be configuration"],
    [".github/workflows/ci.yml", "dot-folders"],
    ["components/.hidden/x.tsx", "dot-folders"],
    ["public/evil.js", "only go under"],
  ])("refuses a registry file targeting %s and writes nothing", async (target, message) => {
    const { call } = await setup({
      runtime: registry({
        [official("card")]: item("card", { registryDependencies: ["bad"] }),
        [official("bad")]: targeted("bad", target),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: "card", overwrite: true })).toEqual({
      error: expect.stringContaining(message),
    });
    // The first item's file was fine, but nothing is written when any part is refused.
    expect((await t.session.workspace.listFiles()).map((f) => f.path)).toEqual(["package.json"]);
    expect(await t.session.workspace.readFile("package.json")).toBe("{}");
  });

  it("writes new files under app/ but never replaces one the site has", async () => {
    const { call } = await setup({
      runtime: registry({
        [official("pricing-page")]: JSON.stringify({
          name: "pricing-page",
          files: [
            { path: "a", type: "registry:page", target: "app/pricing/page.tsx", content: "new" },
            { path: "b", type: "registry:page", target: "app/layout.tsx", content: "evil" },
          ],
        }),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    await call("files", { action: "write", path: "app/layout.tsx", content: "mine" });
    expect(
      await call("add_dependency", { component: "pricing-page", overwrite: true }),
    ).toMatchObject({ files: ["app/pricing/page.tsx"], kept: ["app/layout.tsx"] });
    expect(await t.session.workspace.readFile("app/layout.tsx")).toBe("mine");
  });

  it("a URL item's URL dependencies must come from its own registry", async () => {
    const root = "https://registry.example.com/r/hero.json";
    const { call } = await setup({
      runtime: registry({
        [root]: item("hero", {
          registryDependencies: ["button", "https://registry.example.com/r/glow.json"],
        }),
        [official("button")]: item("button"),
        "https://registry.example.com/r/glow.json": item("glow"),
        "https://registry.example.com/r/bad.json": item("bad", {
          registryDependencies: ["https://elsewhere.example/r/x.json"],
        }),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: root })).toMatchObject({
      added: ["hero", "button", "glow"],
    });
    expect(
      await call("add_dependency", { component: "https://registry.example.com/r/bad.json" }),
    ).toEqual({ error: expect.stringContaining("isn't on https://registry.example.com") });
    expect(await t.session.workspace.readFile("components/ui/bad.tsx")).toBeNull();
  });

  it("leaves the draft untouched when a package can't be resolved or there are too many items", async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 14; i++) {
      chain[official(`c${i}`)] = item(`c${i}`, { registryDependencies: [`c${i + 1}`] });
    }
    const { call } = await setup({
      runtime: registry({
        ...chain,
        [official("needs-pkg")]: item("needs-pkg", { dependencies: ["no-such-pkg"] }),
      }),
    });
    await call("files", { action: "write", path: "package.json", content: "{}" });
    expect(await call("add_dependency", { component: "needs-pkg" })).toEqual({
      error: expect.stringContaining("npm has no package called no-such-pkg"),
    });
    expect(await call("add_dependency", { component: "c0" })).toEqual({
      error: expect.stringContaining("more than 12 components"),
    });
    expect((await t.session.workspace.listFiles()).map((f) => f.path)).toEqual(["package.json"]);
  });
});

/** A CRM with nothing in it, with whatever a test overrides. */
const fakeCrm = (over: Partial<SiteCrm> = {}): SiteCrm => ({
  calendars: async () => [],
  products: async () => [],
  media: async () => [],
  mediaFile: async (id) => {
    throw new CrmMediaError(`There's no image with id ${id} in the client's Media Library.`);
  },
  saveImage: async () => {
    throw new CrmMediaError("Nothing is kept here.");
  },
  ...over,
});

describe("crm tool", () => {
  it("lists the client's calendars as one line each, for the model to pick from", async () => {
    const { call } = await setup();
    t.session.crm = fakeCrm({
      calendars: async () => [
        {
          id: "cal1",
          name: "Consultation",
          type: "event",
          embedUrl: "https://api.leadconnectorhq.com/widget/booking/cal1",
        },
      ],
    });
    expect(await call("crm", { action: "calendars" })).toEqual({
      calendars:
        "id: cal1 | name: Consultation | type: event | embedUrl: https://api.leadconnectorhq.com/widget/booking/cal1",
    });
  });

  it("says when there are no calendars, or no CRM to ask", async () => {
    const { call } = await setup();
    expect(await call("crm", { action: "calendars" })).toEqual({
      error: "The CRM isn't reachable from here.",
    });
    t.session.crm = fakeCrm();
    expect(await call("crm", { action: "calendars" })).toMatchObject({
      note: expect.stringContaining("no active calendars"),
    });
  });

  it("writes Locus's booking pieces, keeping a site's own copy unless told to replace it", async () => {
    const { call } = await setup();
    // A site made before booking: no Locus route, and settings without siteApi.
    await t.session.workspace.writeFile(
      "lib/locus.ts",
      "export const locus = { leadEndpoint: null };",
    );
    expect(await call("crm", { action: "add_booking" })).toMatchObject({
      written: "components/booking.tsx",
      note: expect.stringContaining("calendarId"),
    });
    expect(String(await t.session.workspace.readFile("components/booking.tsx"))).toContain(
      'fetch("/api/locus/booking"',
    );
    expect(
      String(await t.session.workspace.readFile("app/api/locus/[...path]/route.ts")),
    ).toContain('"POST booking"');
    expect(String(await t.session.workspace.readFile("lib/locus.ts"))).toContain("siteApi");
    await t.session.workspace.writeFile("components/booking.tsx", "mine");
    expect(await call("crm", { action: "add_booking" })).toMatchObject({
      kept: "components/booking.tsx",
    });
    expect(await t.session.workspace.readFile("components/booking.tsx")).toBe("mine");
    expect(await call("crm", { action: "add_booking", overwrite: true })).toMatchObject({
      written: "components/booking.tsx",
    });
    expect(await call("crm", { action: "add_calendar_embed" })).toEqual({
      written: "components/calendar-embed.tsx",
    });
  });
});

describe("crm checkout", () => {
  it("lists each one-time price of the client's products as one line, for the model to pick from", async () => {
    const { call } = await setup();
    t.session.crm = fakeCrm({
      products: async () => [
        {
          id: "prod1",
          name: "Deep Clean",
          prices: [
            { id: "price1", name: "Standard", amount: 149.5, currency: "USD" },
            { id: "price2", name: "Large home", amount: 220, currency: "USD" },
          ],
        },
      ],
    });
    expect(await call("crm", { action: "products" })).toEqual({
      products:
        "productId: prod1 | priceId: price1 | product: Deep Clean | price: Standard | amount: 149.50 USD\n" +
        "productId: prod1 | priceId: price2 | product: Deep Clean | price: Large home | amount: 220.00 USD",
    });
  });

  it("says when there's nothing to sell, or no CRM to ask", async () => {
    const { call } = await setup();
    expect(await call("crm", { action: "products" })).toEqual({
      error: "The CRM isn't reachable from here.",
    });
    t.session.crm = fakeCrm();
    expect(await call("crm", { action: "products" })).toMatchObject({
      products: "",
      note: expect.stringContaining("no products with a one-time price"),
    });
  });

  it("writes Locus's buy button and route, keeping a site's own copy unless told to replace it", async () => {
    const { call } = await setup();
    // A site made before checkout: no Locus route, and settings without siteApi.
    await t.session.workspace.writeFile(
      "lib/locus.ts",
      "export const locus = { leadEndpoint: null };",
    );
    expect(await call("crm", { action: "add_checkout" })).toMatchObject({
      written: "components/buy-button.tsx",
      note: expect.stringContaining('priceId="<priceId>"'),
    });
    expect(String(await t.session.workspace.readFile("components/buy-button.tsx"))).toContain(
      'fetch("/api/locus/checkout"',
    );
    expect(
      String(await t.session.workspace.readFile("app/api/locus/[...path]/route.ts")),
    ).toContain('"POST checkout"');
    expect(String(await t.session.workspace.readFile("lib/locus.ts"))).toContain("siteApi");
    await t.session.workspace.writeFile("components/buy-button.tsx", "mine");
    expect(await call("crm", { action: "add_checkout" })).toMatchObject({
      kept: "components/buy-button.tsx",
    });
    expect(await t.session.workspace.readFile("components/buy-button.tsx")).toBe("mine");
    expect(await call("crm", { action: "add_checkout", overwrite: true })).toMatchObject({
      written: "components/buy-button.tsx",
    });
  });
});

describe("crm media", () => {
  const LOGO = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const withMedia = () =>
    fakeCrm({
      media: async (search) =>
        [
          { id: "m1", name: "Logo Final.png", format: "png" as const },
          { id: "m2", name: "team.webp", format: "webp" as const },
        ].filter((m) => !search || m.name.toLowerCase().includes(search)),
      mediaFile: async (id) => {
        if (id === "m1") return { name: "Logo Final.png", format: "png", bytes: LOGO };
        if (id === "m2") return { name: "team.webp", format: "webp", bytes: LOGO };
        throw new CrmMediaError(`There's no image with id ${id} in the client's Media Library.`);
      },
    });

  it("lists the client's images as one line each, and searches by name", async () => {
    const { call } = await setup();
    t.session.crm = withMedia();
    expect(await call("crm", { action: "media" })).toEqual({
      media: "id: m1 | name: Logo Final.png | format: png\nid: m2 | name: team.webp | format: webp",
    });
    expect(await call("crm", { action: "media", search: "zzz" })).toEqual({
      media: "",
      note: "No images match that name.",
    });
  });

  it("makes a logo the site's only icon, and a photo its link preview or a public image", async () => {
    const { call } = await setup();
    t.session.crm = withMedia();
    await t.session.workspace.writeFile("app/favicon.ico", new Uint8Array([0, 0, 1, 0]));
    expect(await call("crm", { action: "use_media", id: "m1", as: "favicon" })).toEqual({
      saved: "app/icon.png",
      bytes: LOGO.byteLength,
    });
    const paths = (await t.session.workspace.listFiles()).map((f) => f.path);
    expect(paths).toContain("app/icon.png");
    expect(paths).not.toContain("app/favicon.ico");
    for (const rival of ["app/twitter-image.jpg", "app/opengraph-image.alt.txt", "app/icon1.png"]) {
      await t.session.workspace.writeFile(rival, "old");
    }
    expect(await call("crm", { action: "use_media", id: "m1", as: "share" })).toMatchObject({
      saved: "app/opengraph-image.png",
    });
    const after = (await t.session.workspace.listFiles()).map((f) => f.path);
    expect(after).not.toContain("app/twitter-image.jpg");
    expect(after).not.toContain("app/opengraph-image.alt.txt");
    // Only the share image's rivals go; a numbered icon is the favicon's business.
    expect(after).toContain("app/icon1.png");
    expect(await call("crm", { action: "use_media", id: "m2", as: "image" })).toMatchObject({
      saved: "public/images/team.webp",
      src: "/images/team.webp",
    });
    expect(await call("crm", { action: "use_media", id: "m1", as: "image" })).toMatchObject({
      saved: "public/images/logo-final.png",
    });
  });

  it("refuses what Next can't use, a path outside public/, and an unknown id", async () => {
    const { call } = await setup();
    t.session.crm = withMedia();
    expect(await call("crm", { action: "use_media", id: "m2", as: "favicon" })).toEqual({
      error: "A webp image can't be the site's icon; pick a png, jpg or ico image.",
    });
    expect(
      await call("crm", { action: "use_media", id: "m1", as: "image", path: "app/logo.png" }),
    ).toEqual({ error: "Save it under public/ with a .png name." });
    expect(
      await call("crm", { action: "use_media", id: "m1", as: "image", path: "public/x.jpg" }),
    ).toEqual({ error: "Save it under public/ with a .png name." });
    expect(await call("crm", { action: "use_media", id: "nope", as: "image" })).toEqual({
      error: "There's no image with id nope in the client's Media Library.",
    });
    expect(await call("crm", { action: "use_media", as: "image" })).toEqual({
      error: "use_media needs the image's id from media.",
    });
  });
});

describe("crm tracking", () => {
  const SNIPPET =
    '<script src="https://link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_abc12345def"></script>';
  const LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`;

  it("writes the script component and renders it once in the layout", async () => {
    const { call } = await setup();
    await t.session.workspace.writeFile("app/layout.tsx", LAYOUT);
    expect(await call("crm", { action: "add_tracking", snippet: SNIPPET })).toMatchObject({
      written: "components/ghl-tracking.tsx",
      layout: "added <GhlTracking />",
    });
    const component = String(await t.session.workspace.readFile("components/ghl-tracking.tsx"));
    expect(component).toContain('src="https://link.msgsndr.com/js/external-tracking.js"');
    expect(component).toContain('data-tracking-id="tk_abc12345def"');
    expect(component).toContain("if (!locus.leadEndpoint) return null;");
    const layout = String(await t.session.workspace.readFile("app/layout.tsx"));
    expect(layout).toContain(
      'import "./globals.css";\nimport { GhlTracking } from "@/components/ghl-tracking";',
    );
    expect(layout).toContain("        {children}\n        <GhlTracking />\n      </body>");
    expect(await call("crm", { action: "add_tracking", snippet: SNIPPET })).toMatchObject({
      layout: "already had it",
    });
    expect(
      String(await t.session.workspace.readFile("app/layout.tsx")).match(/<GhlTracking/g),
    ).toHaveLength(1);
  });

  it("refuses anything but GHL's tracking snippet, and a layout without a body", async () => {
    const { call } = await setup();
    await t.session.workspace.writeFile("app/layout.tsx", LAYOUT);
    for (const snippet of [
      '<script src="https://evil.example/x.js" data-tracking-id="tk_abc12345def"></script>',
      '<script src="http://link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_abc12345def"></script>',
      '<script src="https://link.msgsndr.com/js/external-tracking.js"></script>',
      '<script src="https://link.msgsndr.com/js/external-tracking.js" data-tracking-id="abc"></script>',
    ]) {
      expect(await call("crm", { action: "add_tracking", snippet })).toMatchObject({
        error: expect.stringContaining("isn't the CRM's tracking snippet"),
      });
    }
    await t.session.workspace.writeFile("app/layout.tsx", "export default function L() {}");
    expect(await call("crm", { action: "add_tracking", snippet: SNIPPET })).toMatchObject({
      error: expect.stringContaining("no <body>"),
    });
    expect(await t.session.workspace.readFile("components/ghl-tracking.tsx")).toBeNull();
  });

  it("asks a person before adding any tracking script", async () => {
    const { tools } = await setup();
    // biome-ignore lint/suspicious/noExplicitAny: the rule takes the tool's input
    const rule = tools.crm.requireApproval as (input: any) => boolean;
    expect(rule({ action: "add_tracking", snippet: SNIPPET })).toBe(true);
    expect(rule({ action: "calendars" })).toBe(false);
    expect(rule({ action: "use_media", id: "m1", as: "favicon" })).toBe(false);
  });
});
