import { describe, expect, it } from "vitest";
import { FakeRuntimeProvider } from "./fake.ts";
import { InvalidPathError } from "./paths.ts";

describe("FakeRuntime", () => {
  it("keeps files in memory and records calls", async () => {
    const provider = new FakeRuntimeProvider();
    const runtime = await provider.open("site-1");

    await runtime.writeFiles([
      { path: "app/page.tsx", content: "export default () => null" },
      { path: "./public/a.bin", content: new Uint8Array([1, 2]) },
    ]);
    expect(runtime.readText("app/page.tsx")).toBe("export default () => null");
    expect(runtime.files.get("public/a.bin")).toEqual(new Uint8Array([1, 2]));

    await runtime.deleteFiles(["public"]);
    expect(runtime.files.has("public/a.bin")).toBe(false);

    expect(runtime.calls).toEqual([
      { method: "writeFiles", paths: ["app/page.tsx", "public/a.bin"] },
      { method: "deleteFiles", paths: ["public"] },
    ]);
  });

  it("rejects paths outside the project", async () => {
    const runtime = await new FakeRuntimeProvider().open("s");
    await expect(runtime.writeFiles([{ path: "../x", content: "" }])).rejects.toThrow(
      InvalidPathError,
    );
    await expect(runtime.deleteFiles(["/etc"])).rejects.toThrow(InvalidPathError);
    expect(runtime.calls).toEqual([]);
  });

  it("runs commands through the handler, defaulting to success", async () => {
    const provider = new FakeRuntimeProvider({
      handler: (command, args, files) =>
        command === "pnpm" && args[0] === "typecheck"
          ? { exitCode: 2, stderr: `error in ${[...files.keys()].join(",")}` }
          : undefined,
      files: { "app/page.tsx": "x" },
    });
    const runtime = await provider.open("s");

    expect(await runtime.run("pnpm", ["typecheck"], { timeoutMs: 1000 })).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "error in app/page.tsx",
      timedOut: false,
    });
    expect(await runtime.run("ls")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    expect(runtime.calls).toEqual([
      { method: "run", command: "pnpm", args: ["typecheck"], timeoutMs: 1000 },
      { method: "run", command: "ls", args: [] },
    ]);
  });

  it("truncates handler output to the tail", async () => {
    const runtime = await new FakeRuntimeProvider({
      maxOutputChars: 5,
      handler: () => ({ stdout: "aaaaaaaaaaHELLO" }),
    }).open("s");
    expect((await runtime.run("x")).stdout).toBe("[... 10 characters truncated ...]\nHELLO");
  });

  it("installs only when package.json changed", async () => {
    const seen: string[] = [];
    const runtime = await new FakeRuntimeProvider({
      handler: (command, args) => {
        seen.push([command, ...args].join(" "));
        return undefined;
      },
    }).open("s");

    expect((await runtime.install()).exitCode).toBe(1);
    await runtime.writeFiles([{ path: "package.json", content: '{"name":"a"}' }]);
    expect((await runtime.install()).exitCode).toBe(0);
    expect((await runtime.install()).stdout).toBe("dependencies up to date");
    await runtime.writeFiles([{ path: "package.json", content: '{"name":"b"}' }]);
    await runtime.install();

    expect(seen).toEqual(["pnpm install", "pnpm install"]);
    expect(runtime.calls.filter((c) => c.method === "install")).toEqual([
      { method: "install", skipped: false },
      { method: "install", skipped: false },
      { method: "install", skipped: true },
      { method: "install", skipped: false },
    ]);
  });

  it("installs again when a lockfile changed", async () => {
    let installs = 0;
    const runtime = await new FakeRuntimeProvider({
      files: { "package.json": "{}", "pnpm-lock.yaml": "v1" },
      handler: () => {
        installs++;
        return undefined;
      },
    }).open("s");
    await runtime.install();
    await runtime.install();
    expect(installs).toBe(1);
    await runtime.writeFiles([{ path: "pnpm-lock.yaml", content: "v2" }]);
    await runtime.install();
    expect(installs).toBe(2);
  });

  it("uses npm when there is only a package-lock.json", async () => {
    const seen: string[] = [];
    const runtime = await new FakeRuntimeProvider({
      files: { "package.json": "{}", "package-lock.json": "{}" },
      handler: (command) => {
        seen.push(command);
        return undefined;
      },
    }).open("s");
    await runtime.install();
    expect(seen).toEqual(["npm"]);
  });

  it("serves a fixed preview URL and settable logs", async () => {
    const provider = new FakeRuntimeProvider();
    const runtime = await provider.open("acme");
    expect(await runtime.startPreview()).toEqual({ url: "https://preview.fake/acme" });
    await runtime.startPreview();
    runtime.setPreviewLogs("Module not found: ./missing");
    expect(await runtime.previewLogs()).toBe("Module not found: ./missing");
    expect(runtime.calls).toEqual([
      { method: "startPreview", alreadyRunning: false },
      { method: "startPreview", alreadyRunning: true },
      { method: "previewLogs" },
    ]);
  });

  it("reuses the runtime per key, keeping files across stop", async () => {
    const provider = new FakeRuntimeProvider();
    const a = await provider.open("a");
    await a.writeFiles([{ path: "x.txt", content: "1" }]);
    await a.startPreview();
    await a.stop();
    expect(a.previewRunning).toBe(false);

    const again = await provider.open("a");
    expect(again).toBe(a);
    expect(again.stopped).toBe(false);
    expect(again.readText("x.txt")).toBe("1");
    expect(await provider.open("b")).not.toBe(a);
  });
});
