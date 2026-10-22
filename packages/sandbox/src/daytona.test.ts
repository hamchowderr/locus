import { DaytonaNotFoundError, SandboxState } from "@daytonaio/sdk";
import { DaytonaSandbox, type DaytonaSandboxOptions } from "@mastra/daytona";
import { describe, expect, it, vi } from "vitest";
import { DaytonaRuntimeProvider, type DaytonaSandboxConfig, daytonaFromEnv } from "./daytona.ts";
import { InvalidPathError } from "./paths.ts";
import type { SiteRuntime } from "./runtime.ts";
import { sandboxName } from "./vercel.ts";

// The real `DaytonaSandbox` from @mastra/daytona runs here; only Daytona's API client (and so
// every VM) is a fake. No call leaves the process.

const API_KEY = "daytona-key-must-not-leak";
const ROOT = "/home/daytona/site";
const MARKER = `${ROOT}/.locus/seeded`;

interface Outcome {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Never finishes on its own (a dev server). */
  background?: boolean;
  /** Finishes after this long. */
  delayMs?: number;
}
type Handler = (command: string, vm: FakeVm) => Outcome | undefined | Promise<Outcome | undefined>;

interface FakeVm {
  id: string;
  name: string;
  state: SandboxState;
  createdAt: string;
  files: Map<string, string>;
  commands: string[];
  process: Record<string, (...args: never[]) => unknown>;
  fs: { uploadFiles: (files: { source: Buffer; destination: string }[]) => Promise<void> };
  getSignedPreviewUrl: (port: number, ttl?: number) => Promise<{ url: string; token: string }>;
  getPreviewLink: (port: number) => Promise<{ url: string; token: string }>;
}

/** Daytona's API client, with a tiny shell: commands go to `handler` (exit 0 by default). */
function fakeDaytona(handler: Handler = () => undefined) {
  const vms = new Map<string, FakeVm>();
  const calls = {
    created: [] as Record<string, unknown>[],
    started: [] as string[],
    stopped: [] as string[],
    deleted: [] as string[],
    signed: [] as { port: number; ttl: number | undefined }[],
  };
  let counter = 0;

  const notRunning = () => new Error("Sandbox is not running");

  function makeVm(name: string): FakeVm {
    counter += 1;
    const results = new Map<string, { exitCode: number; done: Promise<void> }>();
    const vm: FakeVm = {
      id: `vm-${counter}`,
      name,
      state: SandboxState.STARTED,
      createdAt: new Date().toISOString(),
      files: new Map(),
      commands: [],
      process: {
        createSession: async () => {
          if (vm.state !== SandboxState.STARTED) throw notRunning();
        },
        executeSessionCommand: async (sessionId: string, req: { command: string }) => {
          if (vm.state !== SandboxState.STARTED) throw notRunning();
          vm.commands.push(req.command);
          const outcome = (await shell(req.command, vm)) ?? {};
          let finish = () => {};
          const done = new Promise<void>((resolve) => {
            finish = resolve;
          });
          results.set(sessionId, { exitCode: outcome.exitCode ?? 0, done });
          (vm as unknown as { pending: Map<string, unknown> }).pending ??= new Map();
          const pending = (vm as unknown as { pending: Map<string, unknown> }).pending;
          pending.set(sessionId, { outcome, finish });
          return { cmdId: `cmd-${sessionId}` };
        },
        getSessionCommandLogs: async (
          sessionId: string,
          _cmdId: string,
          onStdout: (chunk: string) => void,
          onStderr: (chunk: string) => void,
        ) => {
          const pending = (vm as unknown as { pending: Map<string, unknown> }).pending;
          const entry = pending.get(sessionId) as { outcome: Outcome; finish: () => void };
          const { outcome, finish } = entry;
          if (outcome.background) return results.get(sessionId)?.done;
          if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
          if (outcome.stdout) onStdout(outcome.stdout);
          if (outcome.stderr) onStderr(outcome.stderr);
          finish();
        },
        getSessionCommand: async (sessionId: string) => ({
          exitCode: results.get(sessionId)?.exitCode ?? 0,
        }),
        deleteSession: async () => {},
        sendSessionCommandInput: async () => {},
      },
      fs: {
        uploadFiles: async (files) => {
          if (vm.state !== SandboxState.STARTED) throw notRunning();
          for (const file of files) vm.files.set(file.destination, file.source.toString());
        },
      },
      getSignedPreviewUrl: async (port, ttl) => {
        calls.signed.push({ port, ttl });
        return { url: `https://${port}-signed.proxy.daytona.fake`, token: "preview-token" };
      },
      getPreviewLink: async (port) => ({
        url: `https://${port}-${vm.id}.proxy.daytona.fake`,
        token: "preview-token",
      }),
    };
    return vm;
  }

  /** The built-in commands the runtime relies on, then the test's handler. */
  async function shell(command: string, vm: FakeVm): Promise<Outcome | undefined> {
    if (command.includes("test -f") && command.includes(MARKER)) {
      return { exitCode: vm.files.has(MARKER) ? 0 : 1 };
    }
    return handler(command, vm);
  }

  const client = {
    get: async (key: string) => {
      const vm = vms.get(key) ?? [...vms.values()].find((v) => v.id === key);
      if (!vm) throw new DaytonaNotFoundError(`Sandbox with ID or name ${key} not found`, 404);
      return vm;
    },
    create: async (params: Record<string, unknown>) => {
      calls.created.push(params);
      const vm = makeVm(String(params.name));
      vms.set(vm.name, vm);
      return vm;
    },
    start: async (vm: FakeVm) => {
      calls.started.push(vm.name);
      const current = vms.get(vm.name);
      if (current) current.state = SandboxState.STARTED;
      vm.state = SandboxState.STARTED;
    },
    stop: async (vm: FakeVm) => {
      calls.stopped.push(vm.name);
      vm.state = SandboxState.STOPPED;
    },
    delete: async (vm: FakeVm) => {
      calls.deleted.push(vm.name);
      vms.delete(vm.name);
      vm.state = SandboxState.DESTROYED;
    },
  };

  /** `createSandbox` for the provider: the real Mastra sandbox, on the fake client. */
  const options: DaytonaSandboxOptions[] = [];
  const createSandbox = (opts: DaytonaSandboxOptions) => {
    options.push(opts);
    const sandbox = new DaytonaSandbox(opts);
    (sandbox as unknown as { _daytona: unknown })._daytona = client;
    return sandbox;
  };

  return { vms, calls, client, createSandbox, options };
}
type Fake = ReturnType<typeof fakeDaytona>;

function provider(fake: Fake, config: Partial<DaytonaSandboxConfig> = {}) {
  return new DaytonaRuntimeProvider({
    apiKey: API_KEY,
    previewReadyTimeoutMs: 0,
    ...config,
    createSandbox: fake.createSandbox,
  });
}

const vmOf = (fake: Fake, key: string) => fake.vms.get(sandboxName(key));
/** The commands the runtime ran for its callers, without the start hook's seed checks. */
const callerCommands = (vm: FakeVm | undefined) =>
  (vm?.commands ?? []).filter((c) => !c.includes("test -f"));

describe("DaytonaRuntimeProvider", () => {
  it("creates one private, named sandbox per site and never hands the API key to it", async () => {
    const fake = fakeDaytona((command) =>
      command.includes("cat") ? { stdout: "hello" } : undefined,
    );
    const runtimes = provider(fake, { domainAllowList: "registry.npmjs.org" });
    const runtime = await runtimes.open("loc_1/site_1");
    await runtime.writeFiles([{ path: "app/page.tsx", content: "export default 1" }]);
    await runtime.run("cat", ["app/page.tsx"]);
    await runtime.install();
    const { url } = await runtime.startPreview();

    expect(runtime.id).toBe(sandboxName("loc_1/site_1"));
    expect(fake.calls.created).toHaveLength(1);
    const created = fake.calls.created[0] ?? {};
    expect(created).toMatchObject({
      name: sandboxName("loc_1/site_1"),
      public: false,
      autoStopInterval: 30,
      domainAllowList: "registry.npmjs.org",
      labels: { app: "locus", "mastra-sandbox-id": sandboxName("loc_1/site_1") },
    });
    expect(url).toBe("https://3000-signed.proxy.daytona.fake");

    // The key goes to Daytona's client in this process only: not into the VM, a command, a file,
    // the creation request or the URL the browser opens.
    const vm = vmOf(fake, "loc_1/site_1");
    const everything = JSON.stringify({
      created: fake.calls.created,
      commands: vm?.commands,
      files: [...(vm?.files ?? [])],
      url,
    });
    expect(everything).not.toContain(API_KEY);
    for (const command of vm?.commands ?? []) {
      expect(command).not.toMatch(/DAYTONA|API_KEY/);
    }
  });

  it("gives commands only Locus's fixed environment", async () => {
    const fake = fakeDaytona();
    const runtime = await provider(fake).open("site");
    await runtime.run("ls");
    await runtime.install();
    const [run, install] = callerCommands(vmOf(fake, "site"));
    expect(run).toBe(`export NEXT_TELEMETRY_DISABLED=1 && cd ${ROOT} && ('ls')`);
    expect(install).toMatch(/^export NEXT_TELEMETRY_DISABLED=1 && export CI=1 && cd /);
  });

  it("quotes the command, so it runs as one program and never as shell syntax", async () => {
    const fake = fakeDaytona();
    const runtime = await provider(fake).open("site");
    await runtime.run("echo hi; touch /tmp/pwned", ["a b"]);
    const [command] = callerCommands(vmOf(fake, "site"));
    expect(command).toMatch(/&& \('echo hi; touch \/tmp\/pwned' 'a b'\)$/);
  });

  it("reuses the sandbox in-process, and finds it again by name from a new process", async () => {
    const fake = fakeDaytona();
    const runtimes = provider(fake);
    const a = await runtimes.open("site");
    const b = await runtimes.open("site");
    expect(a).toBe(b);
    await provider(fake).open("site");
    expect(fake.calls.created).toHaveLength(1);
  });

  it("seeds a new sandbox once, before anyone else gets it", async () => {
    const fake = fakeDaytona();
    const order: string[] = [];
    let release = () => {};
    const seeded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onCreate = vi.fn(async (_key: string, view: SiteRuntime) => {
      order.push("seed:start");
      await seeded;
      await view.writeFiles([{ path: "package.json", content: "{}" }]);
      order.push("seed:done");
    });
    const runtimes = provider(fake, { onCreate });
    const first = runtimes.open("site").then(async (runtime) => {
      order.push("first:open");
      await runtime.run("first");
    });
    const second = provider(fake, { onCreate })
      .open("other")
      .then(() => order.push("other:open"));
    await vi.waitFor(() => expect(order).toContain("seed:start"));
    expect(order).not.toContain("first:open");
    release();
    await Promise.all([first, second]);
    expect(order.indexOf("seed:done")).toBeLessThan(order.indexOf("first:open"));
    expect(vmOf(fake, "site")?.files.has(MARKER)).toBe(true);
    expect(vmOf(fake, "site")?.files.has(`${ROOT}/package.json`)).toBe(true);

    // Opened again from a new process: already seeded, so not seeded again.
    await provider(fake, { onCreate }).open("site");
    expect(onCreate.mock.calls.filter(([key]) => key === "site")).toHaveLength(1);
  });

  it("runs a failed or interrupted seeding again on the next open", async () => {
    const fake = fakeDaytona();
    const onCreate = vi
      .fn<(key: string, runtime: SiteRuntime) => Promise<void>>()
      .mockRejectedValueOnce(new Error("seeding broke"))
      .mockResolvedValue(undefined);
    const runtimes = provider(fake, { onCreate });
    await expect(runtimes.open("site")).rejects.toThrow(/seeding broke/);
    expect(vmOf(fake, "site")?.files.has(MARKER)).toBe(false);
    await runtimes.open("site");
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(vmOf(fake, "site")?.files.has(MARKER)).toBe(true);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("starts a sandbox Daytona stopped while idle, with its files, and doesn't seed it again", async () => {
    const fake = fakeDaytona();
    const onCreate = vi.fn(async () => {});
    const runtime = await provider(fake, { onCreate }).open("site");
    await runtime.writeFiles([{ path: "a.txt", content: "kept" }]);
    const vm = vmOf(fake, "site") as FakeVm;
    vm.state = SandboxState.STOPPED; // Daytona's auto-stop, unseen by this process

    const result = await runtime.run("ls");
    expect(result.exitCode).toBe(0);
    expect(fake.calls.started).toEqual([sandboxName("site")]);
    expect(vm.files.get(`${ROOT}/a.txt`)).toBe("kept");
    expect(onCreate).toHaveBeenCalledTimes(1);

    vm.state = SandboxState.STOPPED;
    await runtime.writeFiles([{ path: "b.txt", content: "after a stop" }]);
    expect(vm.files.get(`${ROOT}/b.txt`)).toBe("after a stop");
  });

  it("recreates and reseeds a sandbox that was deleted under it", async () => {
    const fake = fakeDaytona();
    const onCreate = vi.fn(async () => {});
    const runtime = await provider(fake, { onCreate }).open("site");
    const old = vmOf(fake, "site") as FakeVm;
    fake.vms.delete(old.name);
    old.state = SandboxState.DESTROYED;

    await runtime.run("ls");
    expect(fake.calls.created).toHaveLength(2);
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(vmOf(fake, "site")?.files.has(MARKER)).toBe(true);
  });

  it("writes files under the project root, making their folders, and refuses unsafe paths", async () => {
    const fake = fakeDaytona();
    const runtime = await provider(fake).open("site");
    await runtime.writeFiles([
      { path: "app/blog/page.tsx", content: "x" },
      { path: "public/logo.png", content: new Uint8Array([1, 2]) },
    ]);
    const vm = vmOf(fake, "site") as FakeVm;
    expect(vm.files.has(`${ROOT}/app/blog/page.tsx`)).toBe(true);
    expect(vm.files.has(`${ROOT}/public/logo.png`)).toBe(true);
    expect(callerCommands(vm)[0]).toContain(`('mkdir' -p -- ${ROOT}/app/blog ${ROOT}/public)`);
    await expect(runtime.writeFiles([{ path: "../escape", content: "" }])).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    await expect(runtime.deleteFiles(["/etc/passwd"])).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("keeps only a bounded tail of command output", async () => {
    const fake = fakeDaytona(() => ({ stdout: "x".repeat(500), stderr: "e".repeat(10) }));
    const runtime = await provider(fake, { maxOutputChars: 100 }).open("site");
    const result = await runtime.run("noisy");
    expect(result.stdout).toMatch(/^\[\.\.\. 400 characters truncated \.\.\.\]\nx{100}$/);
    expect(result.stderr).toBe("e".repeat(10));
  });

  it("reports a command cut at its timeout", async () => {
    const fake = fakeDaytona((command) => (command.includes("slow") ? { delayMs: 200 } : {}));
    const runtime = await provider(fake).open("site");
    const result = await runtime.run("slow", [], { timeoutMs: 20 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("shares one install between concurrent calls, under a lock in the sandbox", async () => {
    const fake = fakeDaytona((command) =>
      command.includes("pnpm install") ? { delayMs: 20, stdout: "installed" } : undefined,
    );
    const runtime = await provider(fake).open("site");
    const [a, b] = await Promise.all([runtime.install(), runtime.install()]);
    expect(a).toBe(b);
    const installs = callerCommands(vmOf(fake, "site")).filter((c) => c.includes("pnpm install"));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("flock 9");
    expect(installs[0]).toContain("node_modules/.locus-install-stamp");
    expect(installs[0]).toContain("npx --yes pnpm@10.28.0 install");
  });

  it("starts next dev once in the background and returns a signed, expiring preview URL", async () => {
    const fake = fakeDaytona((command) => {
      if (command.includes("next dev")) return { background: true };
      // Nothing is running yet.
      if (command.includes("locus-preview.pid") && command.includes("kill -0")) {
        return { exitCode: 1 };
      }
      return undefined;
    });
    const runtime = await provider(fake, { previewUrlTtlSeconds: 600 }).open("site");
    const urls = await Promise.all([runtime.startPreview(), runtime.startPreview()]);
    expect(urls).toEqual([
      { url: "https://3000-signed.proxy.daytona.fake" },
      { url: "https://3000-signed.proxy.daytona.fake" },
    ]);
    const launches = callerCommands(vmOf(fake, "site")).filter((c) => c.includes("next dev"));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("flock -n 9 || exit 0");
    expect(launches[0]).toContain("--port 3000 --hostname 0.0.0.0 > /tmp/locus-preview.log 2>&1");
    expect(fake.calls.signed).toEqual([{ port: 3000, ttl: 600 }]);
  });

  it("leaves a running dev server alone", async () => {
    const fake = fakeDaytona();
    const runtime = await provider(fake).open("site");
    await runtime.startPreview();
    expect(callerCommands(vmOf(fake, "site")).some((c) => c.includes("next dev"))).toBe(false);
  });

  it("waits for the dev server, and a dev server that died is not an error", async () => {
    const fake = fakeDaytona((command) => {
      if (command.includes("kill -0") && command.includes("grep -q next")) return { exitCode: 1 };
      if (command.includes("next dev")) return { background: true };
      if (command.includes("node -e")) return { exitCode: 2 }; // died while starting
      if (command.includes("tail -c")) return { stdout: "Error: Cannot find module 'next'" };
      return undefined;
    });
    const runtime = await provider(fake, { previewReadyTimeoutMs: 5_000 }).open("site");
    await expect(runtime.startPreview()).resolves.toEqual({
      url: "https://3000-signed.proxy.daytona.fake",
    });
    const probe = callerCommands(vmOf(fake, "site")).find((c) => c.includes("node -e"));
    expect(probe).toContain("http://127.0.0.1:3000/");
    expect(await runtime.previewLogs()).toBe("Error: Cannot find module 'next'");
  });

  it("uses the host's preview URL instead of a signed one when given", async () => {
    const fake = fakeDaytona();
    const previewUrl = vi.fn(async (_sandbox: DaytonaSandbox, port: number) => {
      return `https://preview.locus.test/${port}`;
    });
    const runtime = await provider(fake, { previewUrl }).open("site");
    expect(await runtime.startPreview()).toEqual({ url: "https://preview.locus.test/3000" });
    expect(fake.calls.signed).toEqual([]);
  });

  it("stops the sandbox, which the next open starts again", async () => {
    const fake = fakeDaytona();
    const runtimes = provider(fake);
    const runtime = await runtimes.open("site");
    await runtime.stop();
    expect(fake.calls.stopped).toEqual([sandboxName("site")]);
    const again = await runtimes.open("site");
    expect(again).not.toBe(runtime);
    expect(fake.calls.started).toEqual([sandboxName("site")]);
  });

  it("deletes a site's sandbox, held or not, and a deleted site's runtime never comes back", async () => {
    const fake = fakeDaytona();
    const runtimes = provider(fake);
    const runtime = await runtimes.open("site");
    await runtimes.destroy("site");
    expect(fake.calls.deleted).toEqual([sandboxName("site")]);
    await expect(runtime.run("ls")).rejects.toThrow(/deleted/);
    expect(fake.calls.created).toHaveLength(1);

    await provider(fake).open("other");
    await provider(fake).destroy("other");
    expect(fake.calls.deleted).toEqual([sandboxName("site"), sandboxName("other")]);
    // Nothing there: fine.
    await provider(fake).destroy("never-made");
  });
});

describe("daytonaFromEnv", () => {
  it("needs DAYTONA_API_KEY", () => {
    expect(daytonaFromEnv({})).toBeNull();
    expect(daytonaFromEnv({ DAYTONA_API_KEY: API_KEY })).toBeInstanceOf(DaytonaRuntimeProvider);
  });
});
