import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DaytonaNotFoundError, SandboxState } from "@daytonaio/sdk";
import { DaytonaSandbox, type DaytonaSandboxOptions } from "@mastra/daytona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAYTONA_PREVIEW_HOSTS,
  DaytonaRuntimeProvider,
  type DaytonaSandboxConfig,
  daytonaFromEnv,
  installScript,
  previewLaunchScript,
  type SandboxScriptPaths,
} from "./daytona.ts";
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
  /** Folders that exist: `/`, and every absolute path a `mkdir` command named, with its parents. */
  dirs: Set<string>;
  commands: string[];
  process: Record<string, (...args: never[]) => unknown>;
  fs: { uploadFiles: (files: { source: Buffer; destination: string }[]) => Promise<void> };
  getSignedPreviewUrl: (port: number, ttl?: number) => Promise<{ url: string; token: string }>;
  getPreviewLink: (port: number) => Promise<{ url: string; token: string }>;
  cpu: number;
  memory: number;
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
    /** Uploads waiting on `holdUploads`. */
    held: 0,
  };
  let counter = 0;
  /** While set, uploads wait for it (to delete a site with an upload in flight). */
  let uploadGate: Promise<void> | null = null;
  const holdUploads = () => {
    let release = () => {};
    uploadGate = new Promise<void>((resolve) => {
      release = () => {
        uploadGate = null;
        resolve();
      };
    });
    return release;
  };

  const notRunning = () => new Error("Sandbox is not running");
  /** Daytona's upload makes no folders here: the runtime has to have made them. */
  const addDirs = (vm: FakeVm, command: string) => {
    if (!command.includes("mkdir")) return;
    for (const path of command.match(/\/[\w.\-/]+/g) ?? []) {
      for (let dir = path; dir !== "/" && dir !== "."; dir = posix.dirname(dir)) vm.dirs.add(dir);
    }
  };

  /** CPU and memory of Daytona's default snapshots; any other is the default's size. */
  const SNAPSHOT_SIZES: Record<string, { cpu: number; memory: number }> = {
    "daytona-small": { cpu: 1, memory: 1 },
    "daytona-medium": { cpu: 2, memory: 4 },
    "daytona-large": { cpu: 4, memory: 8 },
  };

  function makeVm(name: string, snapshot?: unknown): FakeVm {
    counter += 1;
    const results = new Map<string, { exitCode: number; done: Promise<void> }>();
    const vm: FakeVm = {
      id: `vm-${counter}`,
      name,
      state: SandboxState.STARTED,
      createdAt: new Date().toISOString(),
      files: new Map(),
      dirs: new Set(["/", "/tmp", "/home", "/home/daytona"]),
      commands: [],
      process: {
        createSession: async () => {
          if (vm.state !== SandboxState.STARTED) throw notRunning();
        },
        executeSessionCommand: async (sessionId: string, req: { command: string }) => {
          if (vm.state !== SandboxState.STARTED) throw notRunning();
          vm.commands.push(req.command);
          addDirs(vm, req.command);
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
          if (uploadGate) {
            calls.held += 1;
            await uploadGate;
          }
          // Deleted while the upload was under way.
          if (vm.state !== SandboxState.STARTED) {
            throw new DaytonaNotFoundError(`Sandbox ${vm.id} not found`, 404);
          }
          for (const file of files) {
            if (!vm.dirs.has(posix.dirname(file.destination))) {
              throw new Error(`no such folder: ${posix.dirname(file.destination)}`);
            }
            vm.files.set(file.destination, file.source.toString());
          }
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
      ...(SNAPSHOT_SIZES[String(snapshot)] ?? { cpu: 1, memory: 1 }),
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
      const vm = makeVm(String(params.name), params.snapshot);
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

  return { vms, calls, client, createSandbox, options, holdUploads };
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
  it("says which hosts its previews are served on, for next dev's allowed origins", async () => {
    const fake = fakeDaytona();
    const runtime = await provider(fake).open("site");
    expect(runtime.previewHosts).toEqual(["*.proxy.daytona.works"]);
    expect(runtime.previewHosts).toBe(DAYTONA_PREVIEW_HOSTS);
    const proxied = await provider(fake, { previewHosts: ["*.preview.locus.test"] }).open("other");
    expect(proxied.previewHosts).toEqual(["*.preview.locus.test"]);
  });

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

  it("makes sandboxes from Daytona's 2 CPU / 4 GB snapshot, not its 1 GB default", async () => {
    const fake = fakeDaytona();
    await (await provider(fake).open("site")).install();
    expect(fake.calls.created).toEqual([expect.objectContaining({ snapshot: "daytona-medium" })]);
    expect(vmOf(fake, "site")).toMatchObject({ cpu: 2, memory: 4 });

    const own = fakeDaytona();
    await (await provider(own, { snapshot: "daytona-large" }).open("site")).run("ls");
    expect(own.calls.created).toEqual([expect.objectContaining({ snapshot: "daytona-large" })]);
  });

  it("says plainly when a site's sandbox is too small, instead of letting its install be killed", async () => {
    const tooSmall =
      /has 1 CPUs and 1 GB of memory, and a site needs at least 2 and 4\. .*delete it and it is made again/;
    // A snapshot that's too small.
    const fake = fakeDaytona();
    await expect(provider(fake, { snapshot: "daytona-small" }).open("site")).rejects.toThrow(
      tooSmall,
    );
    expect(callerCommands(vmOf(fake, "site"))).toEqual([]);

    // One made before sandboxes came from the bigger snapshot: refused, and nothing deleted.
    const old = fakeDaytona();
    await (await provider(old).open("site")).run("ls");
    const vm = vmOf(old, "site");
    if (!vm) throw new Error("no sandbox");
    Object.assign(vm, { cpu: 1, memory: 1, state: SandboxState.STOPPED });
    await expect(provider(old).open("site")).rejects.toThrow(tooSmall);
    expect(old.calls.deleted).toEqual([]);
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

  it("shares one install between concurrent calls in this process", async () => {
    const fake = fakeDaytona((command) =>
      command.includes("pnpm install") ? { delayMs: 20, stdout: "installed" } : undefined,
    );
    const runtime = await provider(fake).open("site");
    const [a, b] = await Promise.all([runtime.install(), runtime.install()]);
    expect(a).toBe(b);
    const installs = callerCommands(vmOf(fake, "site")).filter((c) => c.includes("pnpm install"));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain(`CI=1`);
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
    expect(launches[0]).toContain("--port 3000 --hostname 0.0.0.0");
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

  it("never recreates a deleted site's sandbox for a call that was under way", async () => {
    const fake = fakeDaytona();
    const onCreate = vi.fn(async () => {});
    const runtimes = provider(fake, { onCreate });
    const runtime = await runtimes.open("site");
    const release = fake.holdUploads();
    const writing = runtime.writeFiles([{ path: "lead.txt", content: "a deleted client's data" }]);
    writing.catch(() => {});
    await vi.waitFor(() => expect(fake.calls.held).toBe(1));

    await runtimes.destroy("site");
    release(); // the upload now finds its sandbox gone, and Mastra would start a new one

    await expect(writing).rejects.toThrow(/deleted/);
    expect(fake.calls.created).toHaveLength(1);
    expect(fake.vms.size).toBe(0);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await expect(runtime.run("ls")).rejects.toThrow(/deleted/);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("makes the seed marker's folder before writing it", async () => {
    const fake = fakeDaytona();
    await provider(fake, { onCreate: async () => {} }).open("site");
    const vm = vmOf(fake, "site") as FakeVm;
    expect(vm.dirs.has(`${ROOT}/.locus`)).toBe(true);
    expect(vm.files.has(MARKER)).toBe(true);
  });
});

/** Runs a script under `sh` in `cwd`; resolves with its exit code and output. */
function sh(script: string, cwd: string, path: string) {
  const child = spawn("sh", ["-c", script], {
    cwd,
    env: { PATH: `${path}:${posix.dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
  });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, out }));
  });
  return { child, done };
}

async function executable(file: string, body: string) {
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

// The scripts themselves, run for real under sh (with stand-ins for pnpm and next), so the locks
// are shown to work rather than only to be present.
describe("the sandbox's scripts", () => {
  let dir: string;
  let root: string;
  let bin: string;
  let paths: SandboxScriptPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "locus-daytona-"));
    root = join(dir, "site");
    bin = join(dir, "bin");
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(root, "package.json"), '{"name":"site"}');
    paths = {
      installLock: join(dir, "install.lock"),
      previewLock: join(dir, "preview.lock"),
      previewPid: join(dir, "preview.pid"),
      previewLog: join(dir, "preview.log"),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lets only one of two concurrent installs run, and the second finds it done", async () => {
    const runs = join(dir, "runs.log");
    await executable(
      join(bin, "pnpm"),
      `echo "start $$" >> ${runs}; sleep 0.4; echo "end $$" >> ${runs}`,
    );
    const first = sh(installScript(paths), root, bin);
    const second = sh(installScript(paths), root, bin);
    const results = await Promise.all([first.done, second.done]);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    const lines = (await readFile(runs, "utf8")).trim().split("\n");
    // One install, start then end, never two overlapping.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^start /);
    expect(lines[1]).toMatch(/^end /);
    expect(results.some((r) => r.out.includes("dependencies up to date"))).toBe(true);

    // A changed package.json installs again.
    await writeFile(join(root, "package.json"), '{"name":"site","version":"2"}');
    expect((await sh(installScript(paths), root, bin).done).code).toBe(0);
    expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  it("starts one dev server; a second start leaves it running, and one can start once it's gone", async () => {
    const launches = join(dir, "launches.log");
    // A stand-in dev server that leaves a process behind (as next's workers could), holding
    // whatever descriptors it was given.
    await executable(
      join(root, "node_modules", ".bin", "next"),
      [
        `echo "next $*" >> ${launches}`,
        `sleep 30 &`,
        `exec node -e "setTimeout(() => {}, 30000)" next-stand-in`,
      ].join("\n"),
    );
    const pid = async () => Number((await readFile(paths.previewPid, "utf8")).trim());
    const first = sh(previewLaunchScript(3000, paths), root, bin);
    await vi.waitFor(async () => expect(await readFile(launches, "utf8")).toContain("next dev"));
    await vi.waitFor(async () => expect(await pid()).toBeGreaterThan(0));
    const second = await sh(previewLaunchScript(3000, paths), root, bin).done;
    expect(second.code).toBe(0);
    expect((await readFile(launches, "utf8")).trim().split("\n")).toEqual([
      "next dev --port 3000 --hostname 0.0.0.0",
    ]);
    expect(first.child.exitCode).toBeNull();
    // The pid file names the dev server, which is what `previewRunning` checks.
    expect(await readFile(`/proc/${await pid()}/cmdline`, "utf8")).toContain("next-stand-in");

    // The dev server dies; what it left behind must not keep the lock.
    process.kill(await pid(), "SIGKILL");
    expect((await first.done).code).not.toBe(0);
    const third = sh(previewLaunchScript(3000, paths), root, bin);
    await vi.waitFor(async () =>
      expect((await readFile(launches, "utf8")).trim().split("\n")).toHaveLength(2),
    );
    await vi.waitFor(async () => expect(await pid()).not.toBe(0));
    process.kill(await pid(), "SIGKILL");
    await third.done;
  });
});

describe("daytonaFromEnv", () => {
  it("needs DAYTONA_API_KEY", () => {
    expect(daytonaFromEnv({})).toBeNull();
    expect(daytonaFromEnv({ DAYTONA_API_KEY: API_KEY })).toBeInstanceOf(DaytonaRuntimeProvider);
  });
});
