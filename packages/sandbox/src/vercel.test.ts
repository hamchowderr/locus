import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidPathError } from "./paths.ts";
import type { SiteRuntime } from "./runtime.ts";
import { sandboxFromEnv, sandboxName, VercelRuntimeProvider } from "./vercel.ts";

const sdk = vi.hoisted(() => ({ getOrCreate: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { getOrCreate: sdk.getOrCreate, get: sdk.get } }));

const TOKEN = "vercel-token-must-not-leak";
const CONFIG = { token: TOKEN, teamId: "team_1", projectId: "prj_1", timeoutMs: 600_000 };
const MARKER = "/vercel/sandbox/.locus/seeded";

interface RunParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  timeoutMs?: number;
}
interface Outcome {
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  /** Output as a sequence of log lines, instead of stdout/stderr. */
  lines?: Iterable<{ stream: "stdout" | "stderr"; data: string }>;
}

/** What the SDK's runCommand resolves to: a Command (detached) or a CommandFinished. */
function command(outcome: Outcome) {
  const exitCode = outcome.exitCode ?? 0;
  return {
    exitCode,
    async *logs() {
      if (outcome.lines) {
        yield* outcome.lines;
        return;
      }
      if (outcome.stdout) yield { stream: "stdout" as const, data: outcome.stdout };
      if (outcome.stderr) yield { stream: "stderr" as const, data: outcome.stderr };
    },
    wait: async () => ({ exitCode, durationMs: outcome.durationMs }),
  };
}

const script = (params: RunParams | undefined) => params?.args?.[1] ?? "";
const isPreviewLaunch = (params: RunParams) => script(params).includes("next dev");

/** A stand-in for the SDK's `Sandbox`, with every call recorded and a tiny filesystem. */
function fakeSdkSandbox(handler: (params: RunParams) => Outcome | Promise<Outcome> = () => ({})) {
  const sandbox = {
    expiresAt: new Date(Date.now() + 600_000) as Date | undefined,
    runs: [] as RunParams[],
    written: new Set<string>(),
    runCommand: vi.fn(async (params: RunParams) => {
      sandbox.runs.push(params);
      if (params.cmd === "test" && params.args?.[0] === "-f") {
        return command({ exitCode: sandbox.written.has(params.args[1] ?? "") ? 0 : 1 });
      }
      return command(await handler(params));
    }),
    writeFiles: vi.fn(async (files: { path: string; content: string | Uint8Array }[]) => {
      for (const file of files) sandbox.written.add(file.path);
    }),
    mkDir: vi.fn(async () => {}),
    extendTimeout: vi.fn(async (_ms: number) => {}),
    stop: vi.fn(async () => ({})),
    domain: vi.fn((port: number) => `https://sb-${port}.vercel.run`),
  };
  return sandbox;
}
type FakeSdkSandbox = ReturnType<typeof fakeSdkSandbox>;

/** Commands the runtime ran for the agent, without the seed-marker checks. */
const agentRuns = (sandbox: FakeSdkSandbox) => sandbox.runs.filter((r) => r.cmd !== "test");

function gone(status = 404, code?: string) {
  return Object.assign(new Error("gone"), {
    response: { status },
    ...(code ? { json: { error: { code } } } : {}),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** getOrCreate that hands out the given sandboxes in order, firing onCreate for `created` ones. */
function serve(
  ...sandboxes: { sandbox: FakeSdkSandbox; created: boolean; gate?: Promise<void> }[]
) {
  sdk.getOrCreate.mockImplementation(
    async (params: { onCreate?: (s: unknown) => Promise<void> }) => {
      const next = sandboxes.shift();
      if (!next) throw new Error("no more sandboxes");
      await next.gate;
      if (next.created) await params.onCreate?.(next.sandbox);
      return next.sandbox;
    },
  );
}

beforeEach(() => {
  sdk.getOrCreate.mockReset();
  sdk.get.mockReset();
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

  it("uses the deployment's OIDC token on Vercel when no token is set", async () => {
    const provider = sandboxFromEnv({ VERCEL: "1" });
    expect(provider).toBeInstanceOf(VercelRuntimeProvider);
    sdk.getOrCreate.mockRejectedValueOnce(new Error("stop after the call"));
    await expect(provider?.open("site-oidc")).rejects.toThrow();
    const params = sdk.getOrCreate.mock.calls.at(-1)?.[0];
    expect(params).not.toHaveProperty("token");
    expect(params).not.toHaveProperty("teamId");
    expect(params).not.toHaveProperty("projectId");
  });

  it("prefers an explicit token over OIDC, and LOCUS_SANDBOX=off turns both off", () => {
    expect(
      sandboxFromEnv({
        VERCEL: "1",
        LOCUS_SANDBOX: "off",
        LOCUS_SANDBOX_TOKEN: "t",
        LOCUS_SANDBOX_TEAM_ID: "team",
        LOCUS_SANDBOX_PROJECT_ID: "prj",
      }),
    ).toBeNull();
    expect(sandboxFromEnv({ VERCEL: "0" })).toBeNull();
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

  describe("seeding with onCreate", () => {
    it("seeds a new sandbox once, through a view of that sandbox, and marks it", async () => {
      const sandbox = fakeSdkSandbox();
      serve({ sandbox, created: true }, { sandbox, created: false });
      const onCreate = vi.fn(async (_key: string, view: SiteRuntime) => {
        await view.writeFiles([{ path: "app/page.tsx", content: "seed" }]);
      });
      const provider = new VercelRuntimeProvider({ ...CONFIG, onCreate });

      const runtime = await provider.open("new");
      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(onCreate.mock.calls[0]?.[0]).toBe("new");
      expect([...sandbox.written]).toEqual(["/vercel/sandbox/app/page.tsx", MARKER]);

      await runtime.stop();
      await provider.open("new");
      expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it("seeds again on the next open when seeding failed", async () => {
      const sandbox = fakeSdkSandbox();
      serve({ sandbox, created: true }, { sandbox, created: false }, { sandbox, created: false });
      const onCreate = vi.fn(async () => {}).mockRejectedValueOnce(new Error("repo unreachable"));
      const provider = new VercelRuntimeProvider({ ...CONFIG, onCreate });

      await expect(provider.open("s")).rejects.toThrow("repo unreachable");
      expect(sandbox.written.has(MARKER)).toBe(false);

      const runtime = await provider.open("s");
      expect(onCreate).toHaveBeenCalledTimes(2);
      expect(sandbox.written.has(MARKER)).toBe(true);

      await runtime.stop();
      await provider.open("s");
      expect(onCreate).toHaveBeenCalledTimes(2);
    });

    it("does not hand out the runtime to a concurrent open before seeding is done", async () => {
      const sandbox = fakeSdkSandbox();
      serve({ sandbox, created: true });
      const release = deferred();
      const seeding = deferred();
      const onCreate = vi.fn(async () => {
        seeding.resolve();
        await release.promise;
      });
      const provider = new VercelRuntimeProvider({ ...CONFIG, onCreate });

      const first = provider.open("s");
      await seeding.promise;
      let secondDone = false;
      const second = provider.open("s").then((r) => {
        secondDone = true;
        return r;
      });
      await tick();
      expect(secondDone).toBe(false);

      release.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(sandbox.written.has(MARKER)).toBe(true);
      expect(sdk.getOrCreate).toHaveBeenCalledTimes(1);
    });
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

  it("deletes files with rm in the project root, within the command timeout", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, commandTimeoutMs: 7_000 }).open(
      "s",
    );
    await runtime.deleteFiles(["app/old", "./x.ts"]);
    expect(sandbox.runs[0]).toMatchObject({
      cmd: "rm",
      args: ["-rf", "--", "app/old", "x.ts"],
      cwd: "/vercel/sandbox",
      timeoutMs: 7_000,
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
      detached: true,
    });
  });

  it("keeps only the tail of huge output while streaming it", async () => {
    const chunk = "y".repeat(1_000);
    function* flood() {
      for (let i = 0; i < 20_000; i++) yield { stream: "stdout" as const, data: chunk };
      yield { stream: "stdout" as const, data: "LAST LINE" };
      yield { stream: "stderr" as const, data: "err" };
    }
    const sandbox = fakeSdkSandbox(() => ({ exitCode: 2, lines: flood() }));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, maxOutputChars: 1_000 }).open("s");

    const result = await runtime.run("pnpm", ["build"]);
    expect(result.stdout.endsWith("LAST LINE")).toBe(true);
    expect(result.stdout).toContain("[... 19999009 characters truncated ...]");
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stderr).toBe("err");
  });

  it("reports a command killed at its timeout, and only that", async () => {
    const outcomes: Outcome[] = [
      { exitCode: 137, durationMs: 5_000 },
      { exitCode: 137, durationMs: 100 },
      { exitCode: 1, durationMs: 6_000 },
    ];
    const sandbox = fakeSdkSandbox(() => outcomes.shift() ?? {});
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    const opts = { timeoutMs: 5_000 };
    expect(await runtime.run("sleep", ["60"], opts)).toMatchObject({
      exitCode: 137,
      timedOut: true,
    });
    expect((await runtime.run("oom", [], opts)).timedOut).toBe(false);
    expect((await runtime.run("fails", [], opts)).timedOut).toBe(false);
  });

  it("never gives a command the token, in env, args or anywhere else", async () => {
    let previewUp = false;
    const sandbox = fakeSdkSandbox((params) => {
      if (script(params).includes("/proc/")) return { exitCode: previewUp ? 0 : 1 };
      return {};
    });
    serve({ sandbox, created: true });
    const runtime = await new VercelRuntimeProvider({
      ...CONFIG,
      onCreate: async (_key, view) => view.writeFiles([{ path: "a", content: "b" }]),
    }).open("s");

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
    expect(run?.args?.[0]).toBe("-c");
    expect(script(run)).toContain("sha256sum");
    expect(script(run)).toContain("node_modules/.locus-install-stamp");
    expect(script(run)).toContain("pnpm install");
    expect(script(run)).toContain("npm install");
  });

  it("starts next dev once and returns the public URL", async () => {
    let running = false;
    const sandbox = fakeSdkSandbox((params) => {
      if (script(params).includes("/proc/")) return { exitCode: running ? 0 : 1 };
      return {};
    });
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, ports: [3001, 4000] }).open("s");

    expect(await runtime.startPreview()).toEqual({ url: "https://sb-3001.vercel.run" });
    const launches = sandbox.runs.filter(isPreviewLaunch);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ cmd: "sh", cwd: "/vercel/sandbox", detached: true });
    expect(launches[0]).not.toHaveProperty("timeoutMs");
    expect(script(launches[0])).toContain("next dev --port 3001 --hostname 0.0.0.0");
    // It waited for the server to answer.
    expect(sandbox.runs.some((r) => script(r).includes("http://127.0.0.1:3001/"))).toBe(true);

    running = true;
    expect(await runtime.startPreview()).toEqual({ url: "https://sb-3001.vercel.run" });
    expect(sandbox.runs.filter(isPreviewLaunch)).toHaveLength(1);
  });

  it("shares one start between concurrent startPreview calls", async () => {
    let running = false;
    const sandbox = fakeSdkSandbox((params) => {
      if (script(params).includes("/proc/")) return { exitCode: running ? 0 : 1 };
      if (isPreviewLaunch(params)) running = true;
      return {};
    });
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    const urls = await Promise.all([
      runtime.startPreview(),
      runtime.startPreview(),
      runtime.startPreview(),
    ]);
    expect(urls.map((u) => u.url)).toEqual(Array(3).fill("https://sb-3000.vercel.run"));
    expect(sandbox.runs.filter(isPreviewLaunch)).toHaveLength(1);
  });

  it("returns the tail of the dev server log", async () => {
    const sandbox = fakeSdkSandbox(() => ({ stdout: "Failed to compile ./app/page.tsx" }));
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");
    expect(await runtime.previewLogs()).toBe("Failed to compile ./app/page.tsx");
    expect(script(sandbox.runs[0])).toContain("tail -c 64000 /tmp/locus-preview.log");
  });

  it("extends the session timeout when it is running low", async () => {
    const sandbox = fakeSdkSandbox();
    serve({ sandbox, created: false });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    await runtime.run("true");
    expect(sandbox.extendTimeout).not.toHaveBeenCalled();

    // Freeze the clock so the remaining time the provider reads is exactly 100 s.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      sandbox.expiresAt = new Date(now + 100_000);
      await runtime.run("true");
    } finally {
      clock.mockRestore();
    }
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(1);
    expect(sandbox.extendTimeout.mock.calls[0]?.[0]).toBe(500_000);

    // An extension failure (e.g. the plan's maximum) does not fail the command.
    sandbox.extendTimeout.mockRejectedValueOnce(new Error("max duration"));
    expect((await runtime.run("true")).exitCode).toBe(0);
  });

  it.each([
    ["deleted", gone(404)],
    ["snapshot expired", gone(410, "snapshot_not_found")],
  ])("recreates a sandbox that was %s, reseeds it and retries the call", async (_label, error) => {
    const old = fakeSdkSandbox();
    const fresh = fakeSdkSandbox(() => ({ stdout: "ok" }));
    serve({ sandbox: old, created: true }, { sandbox: fresh, created: true });
    const onCreate = vi.fn(async () => {});
    const runtime = await new VercelRuntimeProvider({ ...CONFIG, onCreate }).open("s");
    old.runCommand.mockRejectedValueOnce(error);

    expect(await runtime.run("ls")).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(fresh.written.has(MARKER)).toBe(true);
    expect(agentRuns(fresh)).toHaveLength(1);
    expect(agentRuns(fresh)[0]?.cmd).toBe("ls");

    // Later calls use the new sandbox.
    await runtime.run("pwd");
    expect(agentRuns(fresh)).toHaveLength(2);
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

  it("stop() waits for an open in flight and stops what it opened", async () => {
    const old = fakeSdkSandbox();
    const fresh = fakeSdkSandbox();
    const gate = deferred();
    serve({ sandbox: old, created: false }, { sandbox: fresh, created: false, gate: gate.promise });
    const runtime = await new VercelRuntimeProvider(CONFIG).open("s");

    // The sandbox is gone, so this call is now reopening it.
    old.runCommand.mockRejectedValueOnce(gone(404));
    const running = runtime.run("ls");
    await tick();
    const stopping = runtime.stop();
    gate.resolve();

    await stopping;
    await running;
    expect(fresh.stop).toHaveBeenCalledTimes(1);
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

describe("destroying a site's sandbox", () => {
  it("deletes the named sandbox and the snapshots only it used", async () => {
    const remove = vi.fn(async () => {});
    sdk.get.mockResolvedValue({ delete: remove });
    await new VercelRuntimeProvider(CONFIG).destroy("client-1/site-1");
    expect(sdk.get).toHaveBeenCalledWith({
      name: sandboxName("client-1/site-1"),
      token: TOKEN,
      teamId: "team_1",
      projectId: "prj_1",
      signal: expect.any(AbortSignal),
    });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ deleteOrphanSnapshots: true }));
  });

  it("doesn't stop (and so snapshot) a sandbox this process holds, and never reopens it", async () => {
    const held = fakeSdkSandbox();
    serve({ sandbox: held, created: false }, { sandbox: fakeSdkSandbox(), created: true });
    const provider = new VercelRuntimeProvider(CONFIG);
    const runtime = await provider.open("k");
    const remove = vi.fn(async () => {});
    sdk.get.mockResolvedValue({ delete: remove });
    await provider.destroy("k");
    expect(held.stop).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    // A call already holding the runtime can't bring the sandbox back.
    await expect(runtime.run("ls")).rejects.toThrow("This site was deleted.");
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(1);
    // A later open is a new runtime, for a site of the same key made again.
    await provider.open("k");
    expect(sdk.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("deletes a sandbox that finished opening while the site was being deleted", async () => {
    const gate = deferred();
    const late = Object.assign(fakeSdkSandbox(), { delete: vi.fn(async () => {}) });
    serve({ sandbox: late, created: true, gate: gate.promise });
    sdk.get.mockRejectedValue(gone(404));
    const provider = new VercelRuntimeProvider(CONFIG);
    const opening = provider.open("k");
    await tick();
    await provider.destroy("k");
    gate.resolve();
    await expect(opening).rejects.toThrow("This site was deleted.");
    expect(late.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
  });

  it("is done when the sandbox no longer exists", async () => {
    sdk.get.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    await expect(new VercelRuntimeProvider({ oidc: true }).destroy("k")).resolves.toBeUndefined();
    expect(sdk.get.mock.calls[0]?.[0]).toEqual({
      name: sandboxName("k"),
      signal: expect.any(AbortSignal),
    });
  });

  it("passes on any other failure", async () => {
    sdk.get.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));
    await expect(new VercelRuntimeProvider(CONFIG).destroy("k")).rejects.toThrow("boom");
  });
});
