import { describe, expect, test } from "vitest";
import { FakeRuntimeProvider } from "./fake.ts";
import { LoggedRuntimeProvider, type SandboxLog } from "./logged.ts";

function recorder() {
  const lines: { level: "info" | "error"; message: string; fields: Record<string, unknown> }[] = [];
  const log: SandboxLog = {
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  };
  return { lines, log };
}

describe("sandbox step logs", () => {
  test("one line per step, with the sandbox id, time taken and exit code", async () => {
    const { lines, log } = recorder();
    const provider = new LoggedRuntimeProvider(
      new FakeRuntimeProvider({
        files: { "package.json": "{}" },
        handler: (command) =>
          command.startsWith("npx") ? { exitCode: 2, stdout: "secret output" } : undefined,
      }),
      log,
    );
    const runtime = await provider.open("loc/site");
    await runtime.install();
    await runtime.run("ls");
    await runtime.run("npx --token=abc", ["tsc"]);
    const { url } = await runtime.startPreview();
    await runtime.stop();
    await provider.destroy?.("loc/site");

    expect(lines.map((line) => [line.level, line.message])).toEqual([
      ["info", "sandbox open"],
      ["info", "sandbox install"],
      ["error", "sandbox command failed"],
      ["info", "sandbox preview start"],
      ["info", "sandbox stop"],
      ["info", "sandbox delete"],
    ]);
    expect(lines[0]?.fields).toMatchObject({ key: "loc/site", sandbox: "fake-loc/site" });
    expect(lines[1]?.fields).toMatchObject({ exitCode: 0, ms: expect.any(Number) });
    expect(lines[2]?.fields).toEqual({
      key: "loc/site",
      sandbox: "fake-loc/site",
      command: "npx",
      exitCode: 2,
    });
    // No arguments, output or preview URL ever reach the logs.
    const all = JSON.stringify(lines);
    for (const hidden of ["--token=abc", "secret output", url]) expect(all).not.toContain(hidden);
  });

  test("a failing step is logged with its error and still throws", async () => {
    const { lines, log } = recorder();
    const inner = new FakeRuntimeProvider();
    inner.open = async () => {
      throw new Error("Preparing the sandbox failed (exit 1): mkdir: /site/app/secret-path");
    };
    const provider = new LoggedRuntimeProvider(inner, log);
    await expect(provider.open("loc/site")).rejects.toThrow("Preparing the sandbox failed");
    expect(lines).toEqual([
      {
        level: "error",
        message: "sandbox open failed",
        fields: {
          key: "loc/site",
          ms: expect.any(Number),
          error: "Error: Preparing the sandbox failed (exit 1)",
        },
      },
    ]);
  });

  test("a failed install is one error line", async () => {
    const { lines, log } = recorder();
    const provider = new LoggedRuntimeProvider(
      new FakeRuntimeProvider({
        files: { "package.json": "{}" },
        handler: () => ({ exitCode: 1 }),
      }),
      log,
    );
    await (await provider.open("loc/site")).install();
    expect(lines.map((line) => line.message)).toEqual(["sandbox open", "sandbox install failed"]);
  });

  test("a provider that can't delete sandboxes stays that way", () => {
    const provider = new LoggedRuntimeProvider(
      { open: new FakeRuntimeProvider().open },
      recorder().log,
    );
    expect(provider.destroy).toBeUndefined();
  });
});
