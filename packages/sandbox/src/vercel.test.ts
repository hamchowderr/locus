import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidPathError } from "./paths.ts";
import { sandboxFromEnv, sandboxName, VercelRuntimeProvider } from "./vercel.ts";

const sdk = vi.hoisted(() => ({ getOrCreate: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { getOrCreate: sdk.getOrCreate } }));

const TOKEN = "vercel-token-must-not-leak";
const CONFIG = { token: TOKEN, teamId: "team_1", projectId: "prj_1", timeoutMs: 600_000 };

interface RunParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  timeoutMs?: number;
}
type Outcome = { exitCode?: number; stdout?: string; stderr?: string };

function finished(outcome: Outcome = {}) {
  return {
    exitCode: outcome.exitCode ?? 0,
    stdout: async () => outcome.stdout ?? "",
    stderr: async () => outcome.stderr ?? "",
  };
}

/** A stand-in for the SDK's `Sandbox`, with every call recorded. */
function fakeSdkSandbox(handler: (params: RunParams) => Outcome | Promise<Outcome> = () => ({})) {
  const sandbox = {
    expiresAt: new Date(Date.now() + 600_000) as Date | undefined,
    runs: [] as RunParams[],
    runCommand: vi.fn(async (params: RunParams) => {
      sandbox.runs.push(params);
      if (params.detached) return { cmdId: "cmd_1" };
      return finished(await handler(params));
    }),
    writeFiles: vi.fn(async (_files: { path: string; content: string | Uint8Array }[]) => {}),
    mkDir: vi.fn(async () => {}),
    extendTimeout: vi.fn(async (_ms: number) => {}),
    stop: vi.fn(async () => ({})),
    domain: vi.fn((port: number) => `https://sb-${port}.vercel.run`),
  };
  return sandbox;
}

function gone(status = 404, code?: string) {
  return Object.assign(new Error("gone"), {
    response: { status },
    ...(code ? { json: { error: { code } } } : {}),
  });
}

/** getOrCreate that hands out the given sandboxes in order, firing onCreate for `created` ones. */
function serve(...sandboxes: { sandbox: ReturnType<typeof fakeSdkSandbox>; created: boolean }[]) {
  sdk.getOrCreate.mockImplementation(
    async (params: { onCreate?: (s: unknown) => Promise<void> }) => {
      const next = sandboxes.shift();
      if (!next) throw new Error("no more sandboxes");
      if (next.created) await params.onCreate?.(next.sandbox);
      return next.sandbox;
    },
  );
}

beforeEach(() => {
  sdk.getOrCreate.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sandboxFromEnv", () => {
  it("returns null unless token, team and project are all set", () => {
    expect(sandboxFromEnv({})).toBeNull();
    expect(sandboxFromEnv({ LOCUS_SANDBOX_TOKEN: "t", LOCUS_SANDBOX_TEAM_ID: "team" })).toBeNull();
    expect(
      sandboxFromEnv({
        LOCUS_SANDBOX_TOKEN: "t",
        LOCUS_SANDBOX_TEAM_ID: "team",
        LOCUS_SANDBOX_PROJECT_ID: "",
      }),
    ).toBeNull();
    expect(
      sandboxFromEnv({
        LOCUS_SANDBOX_TOKEN: "t",
        LOCUS_SANDBOX_TEAM_ID: "team",
        LOCUS_SANDBOX_PROJECT_ID: "prj",
      }),
    ).toBeInstanceOf(VercelRuntimeProvider);
  });

  it("does not load the SDK until a runtime is opened", () => {
    sandboxFromEnv({
      LOCUS_SANDBOX_TOKEN: "t",
      LOCUS_SANDBOX_TEAM_ID: "team",
      LOCUS_SANDBOX_PROJECT_ID: "prj",
    });
    expect(sdk.getOrCreate).not.toHaveBeenCalled();
  });
});

describe("VercelRuntimeProvider", () => {
  it("opens one named, persistent sandbox per key and reuses it", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: true });
    const provider = new VercelRuntimeProvider(CONFIG);

    const [a, b] = await Promise.all([provider.open("site-1"), provider.open("site-1")]);
    expect(a).toBe(b);
    expect(await provider.open("site-1")).toBe(a);
    expect(a.id).toBe(sandboxName("site-1"));
    expect(a.id).toMatch(/^locus-site-[0-9a-f]{24}$/);
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(1);

    const params = sdk.getOrCreate.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      name: a.id,
      token: TOKEN,
      teamId: "team_1",
      projectId: "prj_1",
      image: "vercel/sandbox/node:22",
      ports: [3000],
      timeout: 600_000,
      persistent: true,
    });
    // Credentials authenticate the API call only: no sandbox-wide environment at all.
    expect(params).not.toHaveProperty("env");
  });

  it("calls onCreate when the sandbox was created empty", async () => {
    serve(
      { sandbox: fakeSdkSandbox(), created: true },
      { sandbox: fakeSdkSandbox(), created: false },
    );
    const onCreate = vi.fn(async () => {});
    const provider = new VercelRuntimeProvider({ ...CONFIG, onCreate });
    const runtime = await provider.open("new");
    expect(onCreate).toHaveBeenCalledWith("new", runtime);

    await runtime.stop();
    await provider.open("new");
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("writes files under the project root and validates every path first", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    await runtime.writeFiles([
      { path: "app/page.tsx", content: "x" },
      { path: "./public/a.bin", content: new Uint8Array([1]) },
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: "/vercel/sandbox/app/page.tsx", content: "x" },
      { path: "/vercel/sandbox/public/a.bin", content: new Uint8Array([1]) },
    ]);

    for (const path of ["../escape", "/etc/passwd", "a\0b", "app/../../x"]) {
      await expect(
        runtime.writeFiles([
          { path: "ok.txt", content: "" },
          { path, content: "" },
        ]),
      ).rejects.toThrow(InvalidPathError);
      await expect(runtime.deleteFiles([path])).rejects.toThrow(InvalidPathError);
    }
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(sandbox.runs).toEqual([]);
  });

  it("deletes files with rm in the project root", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");
    await runtime.deleteFiles(["app/old", "./x.ts"]);
    expect(sandbox.runs[0]).toMatchObject({
      cmd: "rm",
      args: ["-rf", "--", "app/old", "x.ts"],
      cwd: "/vercel/sandbox",
    });
  });

  it("runs commands in the project root with bounded output", async () => {
    const sandbox = fakeSdkSandbox(() => ({
      exitCode: 1,
      stdout: `${"x".repeat(50)}tail`,
      stderr: "Type error",
    }));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, maxOutputChars: 4 }).open("s");

    const result = await runtime.run("pnpm", ["typecheck"], { timeoutMs: 1234 });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "[... 50 characters truncated ...]\ntail",
      stderr: "[... 6 characters truncated ...]\nrror",
      timedOut: false,
    });
    expect(sandbox.runs[0]).toEqual({
      cmd: "pnpm",
      args: ["typecheck"],
      cwd: "/vercel/sandbox",
      env: { NEXT_TELEMETRY_DISABLED: "1" },
      timeoutMs: 1234,
    });
  });

  it("reports a command killed at its timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sandbox = fakeSdkSandbox(() => {
      vi.setSystemTime(Date.now() + 5_001);
      return { exitCode: 137 };
    });
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");
    const result = await runtime.run("sleep", ["60"], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 137, timedOut: true });
  });

  it("never gives a command the token, in env, args or anywhere else", async () => {
    let previewUp = false;
    const sandbox = fakeSdkSandbox((params) => {
      const script = params.args?.[1] ?? "";
      if (script.includes("kill -0") && !script.includes("while")) {
        return { exitCode: previewUp ? 0 : 1 };
      }
      return {};
    });
    serve({ sandbox, created: true });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    await runtime.writeFiles([{ path: "package.json", content: "{}" }]);
    await runtime.install();
    await runtime.run("pnpm", ["build"]);
    await runtime.startPreview();
    previewUp = true;
    await runtime.startPreview();
    await runtime.previewLogs();
    await runtime.deleteFiles(["x"]);

    expect(sandbox.runs.length).toBeGreaterThan(5);
    expect(JSON.stringify(sandbox.runs)).not.toContain(TOKEN);
    expect(JSON.stringify(sandbox.writeFiles.mock.calls)).not.toContain(TOKEN);
    for (const run of sandbox.runs) {
      for (const [name, value] of Object.entries(run.env ?? {})) {
        expect(name).not.toMatch(/TOKEN|SECRET|KEY|VERCEL/);
        expect(value).not.toContain(TOKEN);
      }
    }
  });

  it("installs through a script that skips an unchanged package.json", async () => {
    const sandbox = fakeSdkSandbox(() => ({ stdout: "dependencies up to date" }));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    const result = await runtime.install();
    expect(result).toMatchObject({ exitCode: 0, stdout: "dependencies up to date" });
    const run = sandbox.runs[0];
    expect(run).toMatchObject({
      cmd: "sh",
      cwd: "/vercel/sandbox",
      env: { NEXT_TELEMETRY_DISABLED: "1", CI: "1" },
      timeoutMs: 600_000,
    });
    const script = run?.args?.[1] ?? "";
    expect(run?.args?.[0]).toBe("-c");
    expect(script).toContain("sha256sum");
    expect(script).toContain("node_modules/.locus-install-stamp");
    expect(script).toContain("pnpm install");
    expect(script).toContain("npm install");
  });

  it("starts next dev once, detached, and returns the public URL", async () => {
    let running = false;
    const sandbox = fakeSdkSandbox((params) => {
      const script = params.args?.[1] ?? "";
      if (script.includes("/proc/")) return { exitCode: running ? 0 : 1 };
      return {};
    });
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, ports: [3001, 4000] }).open("s");

    expect(await runtime.startPreview()).toEqual({ url: "https://sb-3001.vercel.run" });
    const detached = sandbox.runs.filter((r) => r.detached);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({ cmd: "sh", cwd: "/vercel/sandbox" });
    expect(detached[0]?.args?.[1]).toContain("next dev --port 3001 --hostname 0.0.0.0");
    // It waited for the server to answer.
    expect(sandbox.runs.some((r) => r.args?.[1]?.includes("http://127.0.0.1:3001/"))).toBe(true);

    running = true;
    expect(await runtime.startPreview()).toEqual({ url: "https://sb-3001.vercel.run" });
    expect(sandbox.runs.filter((r) => r.detached)).toHaveLength(1);
  });

  it("returns the tail of the dev server log", async () => {
    const sandbox = fakeSdkSandbox(() => ({ stdout: "Failed to compile ./app/page.tsx" }));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");
    expect(await runtime.previewLogs()).toBe("Failed to compile ./app/page.tsx");
    expect(sandbox.runs[0]?.args?.[1]).toContain("tail -c 64000 /tmp/locus-preview.log");
  });

  it("extends the session timeout when it is running low", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    await runtime.run("true");
    expect(sandbox.extendTimeout).not.toHaveBeenCalled();

    sandbox.expiresAt = new Date(Date.now() + 100_000);
    await runtime.run("true");
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(1);
    const extendBy = sandbox.extendTimeout.mock.calls[0]?.[0] ?? 0;
    expect(extendBy).toBeGreaterThan(490_000);
    expect(extendBy).toBeLessThanOrEqual(500_000);

    // An extension failure (e.g. the plan's maximum) does not fail the command.
    sandbox.extendTimeout.mockRejectedValueOnce(new Error("max duration"));
    expect((await runtime.run("true")).exitCode).toBe(0);
  });

  it.each([
    ["deleted", gone(404)],
    ["snapshot expired", gone(410, "snapshot_not_found")],
  ])("recreates a sandbox that was %s and retries", async (_label, error) => {
    const old = fakeSdkSandbox();
    old.runCommand.mockRejectedValueOnce(error);
    const fresh = fakeSdkSandbox(() => ({ stdout: "ok" }));
    serve({ sandbox: old, created: false }, { sandbox: fresh, created: true });
    const onCreate = vi.fn(async () => {});
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, onCreate }).open("s");

    expect((await runtime.run("ls")).stdout).toBe("ok");
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(fresh.runs).toHaveLength(1);
  });

  it("does not retry other errors", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.runCommand.mockRejectedValueOnce(gone(500));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");
    await expect(runtime.run("ls")).rejects.toThrow("gone");
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("stops the sandbox and opens it again on the next open", async () => {
    const first = fakeSdkSandbox();
    const second = fakeSdkSandbox();
    serve({ sandbox: first, created: false }, { sandbox: second, created: false });
    const provider = new VercelRuntimeProvider(CONFIG);

    const runtime = await provider.open("s");
    await runtime.stop();
    expect(first.stop).toHaveBeenCalledTimes(1);

    const reopened = await provider.open("s");
    expect(reopened).not.toBe(runtime);
    expect(reopened.id).toBe(runtime.id);
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("forgets a key whose open failed", async () => {
    sdk.getOrCreate.mockRejectedValueOnce(new Error("quota"));
    serve({ sandbox: fakeSdkSandbox(), created: false });
    const provider = new VercelRuntimeProvider(CONFIG);
    await expect(provider.open("s")).rejects.toThrow("quota");
    await expect(provider.open("s")).resolves.toBeDefined();
  });

  it("refuses incomplete config", () => {
    expect(() => new VercelRuntimeProvider({ ...CONFIG, token: "" })).toThrow();
    expect(() => new VercelRuntimeProvider({ ...CONFIG, ports: [] })).toThrow();
  });
});
