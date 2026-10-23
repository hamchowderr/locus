import { createRequire } from "node:module";
import { posix } from "node:path";
import type { E2BSandboxOptions } from "@mastra/e2b";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2B_PREVIEW_HOSTS,
  E2BRuntimeProvider,
  type E2BSandboxConfig,
  e2bFromEnv,
  e2bOptions,
} from "./e2b.ts";
import { InvalidPathError } from "./paths.ts";
import type { SiteRuntime } from "./runtime.ts";
import { sandboxName } from "./vercel.ts";

// The real `E2BSandbox` from @mastra/e2b runs here; only the E2B SDK's API calls (and so every
// VM) are fakes. No call leaves the process.

// The SDK as Node loads it for @mastra/e2b (its CommonJS build, which `e2b` has no `exports` to
// redirect), so the fakes below replace the very functions Mastra calls.
const { Sandbox, Template, TemplateBase } = createRequire(import.meta.url)(
  "e2b",
) as typeof import("e2b");

const API_KEY = "e2b-key-must-not-leak";
const ROOT = "/home/user/site";
const MARKER = `${ROOT}/.locus/seeded`;
const GIB_KB = 1024 * 1024;

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
  sandboxId: string;
  state: "running" | "paused" | "killed";
  metadata: Record<string, string>;
  files: Map<string, string>;
  commands: string[];
  cpu: number;
  memoryKb: number;
  timeouts: number[];
}

/** E2B's API, with a tiny shell: commands go to `handler` (exit 0 by default). */
function fakeE2B(handler: Handler = () => undefined) {
  const vms = new Map<string, FakeVm>();
  const calls = {
    created: [] as { template: string; opts: Record<string, unknown> }[],
    connected: [] as string[],
    paused: [] as string[],
    killed: [] as string[],
    builds: [] as { ref: string; opts: Record<string, unknown> }[],
    /** Uploads waiting on `holdUploads`. */
    held: 0,
  };
  const templates = new Set<string>();
  /** Template sizes, as built; what a sandbox made from one gets. */
  const sizes = new Map<string, { cpu: number; memoryKb: number }>();
  let counter = 0;
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

  const gone = (vm: FakeVm) => new Error(`Paused sandbox ${vm.sandboxId} not found`);

  async function shell(command: string, vm: FakeVm): Promise<Outcome> {
    if (command.includes("/proc/meminfo")) {
      return {
        stdout: `${vm.cpu} ${vm.memoryKb}\n`,
        exitCode: command.includes(MARKER) && !vm.files.has(MARKER) ? 1 : 0,
      };
    }
    return (await handler(command, vm)) ?? {};
  }

  function handle(vm: FakeVm) {
    let pid = 100;
    return {
      run: async (
        command: string,
        opts: {
          background?: boolean;
          timeoutMs?: number;
          onStdout?: (data: string) => void;
          onStderr?: (data: string) => void;
        } = {},
      ) => {
        if (vm.state !== "running") throw gone(vm);
        vm.commands.push(command);
        pid += 1;
        const outcome = await shell(command, vm);
        const finish = async () => {
          // Output streams in after `run` has returned, as from E2B.
          await new Promise((r) => setTimeout(r, 0));
          if (outcome.delayMs) {
            const limit = opts.timeoutMs ?? 60_000;
            if (limit > 0 && limit < outcome.delayMs) {
              await new Promise((r) => setTimeout(r, limit));
              throw Object.assign(
                new Error(
                  "[deadline_exceeded] context deadline exceeded: This error is likely due to exceeding 'timeoutMs'",
                ),
                {},
              );
            }
            await new Promise((r) => setTimeout(r, outcome.delayMs));
          }
          if (outcome.stdout) opts.onStdout?.(outcome.stdout);
          if (outcome.stderr) opts.onStderr?.(outcome.stderr);
          const exitCode = outcome.exitCode ?? 0;
          const result = { exitCode, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
          if (exitCode !== 0) throw Object.assign(new Error(`exit status ${exitCode}`), result);
          return result;
        };
        if (!opts.background) {
          try {
            return await finish();
          } catch (error) {
            return error as { exitCode: number; stdout: string; stderr: string };
          }
        }
        const done = outcome.background ? new Promise<never>(() => {}) : finish();
        done.catch(() => {});
        const h = {
          pid,
          exitCode: undefined as number | undefined,
          wait: () => done,
          kill: async () => true,
        };
        done.then(
          (r) => {
            h.exitCode = r.exitCode;
          },
          (e: { exitCode?: number }) => {
            h.exitCode = e.exitCode ?? 1;
          },
        );
        return h;
      },
      list: async () => [],
      sendStdin: async () => {},
      connect: async () => {
        throw new Error("no such process");
      },
    };
  }

  function sdk(vm: FakeVm) {
    return {
      sandboxId: vm.sandboxId,
      commands: handle(vm),
      files: {
        write: async (entries: { path: string; data: string | Blob }[] | string, data?: string) => {
          if (vm.state !== "running") throw gone(vm);
          if (uploadGate) {
            calls.held += 1;
            await uploadGate;
          }
          if (vm.state !== "running") throw gone(vm);
          const list =
            typeof entries === "string" ? [{ path: entries, data: data ?? "" }] : entries;
          for (const entry of list) {
            const text = typeof entry.data === "string" ? entry.data : await entry.data.text();
            vm.files.set(entry.path, text);
          }
        },
      },
      setTimeout: async (ms: number) => {
        vm.timeouts.push(ms);
      },
      getHost: (port: number) => `${port}-${vm.sandboxId}.e2b.fake`,
      pause: async () => {
        calls.paused.push(vm.sandboxId);
        vm.state = "paused";
      },
      kill: async () => {
        calls.killed.push(vm.sandboxId);
        vm.state = "killed";
        vms.delete(vm.sandboxId);
      },
    };
  }

  const info = (vm: FakeVm) => ({
    sandboxId: vm.sandboxId,
    state: vm.state,
    metadata: vm.metadata,
  });

  const api = {
    "Template.exists": async (ref: string) => templates.has(ref),
    "Template.build": (async (
      _template: unknown,
      ref: string,
      opts: Record<string, unknown> = {},
    ) => {
      calls.builds.push({ ref, opts });
      templates.add(ref);
      sizes.set(ref, {
        cpu: Number(opts.cpuCount ?? 2),
        memoryKb: (Number(opts.memoryMB ?? 512) / 1024) * GIB_KB - 100_000,
      });
      return { templateId: ref, buildId: "build-1" };
    }) as never,
    "Sandbox.create": (async (template: string, opts: Record<string, unknown>) => {
      calls.created.push({ template, opts });
      counter += 1;
      const size = sizes.get(template) ?? { cpu: 2, memoryKb: 0.5 * GIB_KB };
      const vm: FakeVm = {
        sandboxId: `sbx${counter}`,
        state: "running",
        metadata: (opts.metadata as Record<string, string>) ?? {},
        files: new Map(),
        commands: [],
        timeouts: [],
        ...size,
      };
      vms.set(vm.sandboxId, vm);
      return sdk(vm);
    }) as never,
    "Sandbox.connect": (async (sandboxId: string) => {
      const vm = vms.get(sandboxId);
      if (!vm) throw new Error(`Sandbox ${sandboxId} not found`);
      calls.connected.push(sandboxId);
      vm.state = "running";
      return sdk(vm);
    }) as never,
    "Sandbox.getInfo": (async (sandboxId: string) => {
      const vm = vms.get(sandboxId);
      if (!vm) throw new Error(`Sandbox ${sandboxId} not found`);
      return info(vm);
    }) as never,
    "Sandbox.list": ((opts: { query?: { metadata?: Record<string, string> } }) => ({
      nextItems: async () =>
        [...vms.values()]
          .filter((vm) =>
            Object.entries(opts.query?.metadata ?? {}).every(([k, v]) => vm.metadata[k] === v),
          )
          .map(info),
    })) as never,
    "Sandbox.kill": (async (sandboxId: string) => {
      const vm = vms.get(sandboxId);
      calls.killed.push(sandboxId);
      if (vm) vm.state = "killed";
      return vms.delete(sandboxId);
    }) as never,
  };

  const options: E2BSandboxOptions[] = [];
  const createSandbox = async (opts: E2BSandboxOptions) => {
    options.push(opts);
    const { E2BSandbox } = await import("@mastra/e2b");
    return new E2BSandbox(opts);
  };

  const vmOf = (key: string) =>
    [...vms.values()].find((vm) => vm.metadata["mastra-sandbox-id"] === sandboxName(key));

  return { vms, calls, createSandbox, options, holdUploads, api, vmOf };
}
type Fake = ReturnType<typeof fakeE2B>;

// The SDK's static calls, pointed at the current test's fake. Set once, on `TemplateBase` itself:
// `Template` is a proxy that binds each static on first read and keeps it.
let current: Fake | null = null;
const STATICS = [
  [TemplateBase, "exists"],
  [TemplateBase, "build"],
  [Sandbox, "create"],
  [Sandbox, "connect"],
  [Sandbox, "getInfo"],
  [Sandbox, "list"],
  [Sandbox, "kill"],
] as const;
const originals = STATICS.map(
  ([owner, name]) => (owner as unknown as Record<string, unknown>)[name],
);
beforeAll(() => {
  for (const [owner, name] of STATICS) {
    const key = `${owner === TemplateBase ? "Template" : "Sandbox"}.${name}` as keyof Fake["api"];
    (owner as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (!current) throw new Error(`no fake E2B for ${key}`);
      return (current.api[key] as (...a: unknown[]) => unknown)(...args);
    };
  }
});
afterAll(() => {
  STATICS.forEach(([owner, name], i) => {
    (owner as unknown as Record<string, unknown>)[name] = originals[i];
  });
});
afterEach(() => {
  current = null;
});

function e2b(handler?: Handler) {
  current = fakeE2B(handler);
  return current;
}

function provider(fake: Fake, config: Partial<E2BSandboxConfig> = {}) {
  return new E2BRuntimeProvider({
    apiKey: API_KEY,
    previewReadyTimeoutMs: 0,
    ...config,
    createSandbox: fake.createSandbox,
  });
}

/** The commands the runtime ran for its callers, without the start hook's seed checks. */
const callerCommands = (vm: FakeVm | undefined) =>
  (vm?.commands ?? []).filter(
    (c) =>
      !c.includes("/proc/meminfo") && !c.includes("/proc/mounts") && !c.includes("mastra-mounts"),
  );

describe("E2BRuntimeProvider", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("says which hosts its previews are served on, for next dev's allowed origins", async () => {
    const fake = e2b();
    const runtime = await provider(fake).open("site");
    expect(runtime.previewHosts).toEqual(["*.e2b.app"]);
    expect(runtime.previewHosts).toBe(E2B_PREVIEW_HOSTS);
    const own = await provider(fake, { domain: "sandbox.locus.test" }).open("other");
    expect(own.previewHosts).toEqual(["*.sandbox.locus.test"]);
  });

  it("creates one named sandbox per site and never hands the API key to it", async () => {
    const fake = e2b((command) => (command.includes("cat") ? { stdout: "hello" } : undefined));
    const runtime = await provider(fake).open("loc_1/site_1");
    await runtime.writeFiles([{ path: "app/page.tsx", content: "export default 1" }]);
    await runtime.run("cat", ["app/page.tsx"]);
    await runtime.install();
    const { url } = await runtime.startPreview();

    expect(runtime.id).toBe(sandboxName("loc_1/site_1"));
    expect(fake.calls.created).toHaveLength(1);
    const created = fake.calls.created[0];
    expect(created?.template).toBe("locus-site-v1");
    expect(created?.opts).toMatchObject({
      apiKey: API_KEY,
      lifecycle: { onTimeout: "pause", autoResume: true },
      metadata: { app: "locus", "mastra-sandbox-id": sandboxName("loc_1/site_1") },
      timeoutMs: 15 * 60_000,
    });
    const vm = fake.vmOf("loc_1/site_1");
    expect(url).toBe(`https://3000-${vm?.sandboxId}.e2b.fake`);

    // The key goes to E2B's client in this process only: not into the VM, a command, a file or
    // the URL the browser opens.
    const everything = JSON.stringify({
      commands: vm?.commands,
      files: [...(vm?.files ?? [])],
      url,
    });
    expect(everything).not.toContain(API_KEY);
    for (const command of vm?.commands ?? []) expect(command).not.toMatch(/E2B|API_KEY/);
  });

  it("builds its template once, at 2 CPUs and 4 GB, with no smaller fallback", async () => {
    const fake = e2b();
    await (await provider(fake).open("site")).install();
    await (await provider(fake).open("other")).install();
    expect(fake.calls.builds).toEqual([
      { ref: "locus-site-v1", opts: expect.objectContaining({ cpuCount: 2, memoryMB: 4096 }) },
    ]);
    expect(fake.options[0]?.template).toMatchObject({ fallbackTemplate: false });

    const own = e2b();
    await (
      await provider(own, { templateName: "locus-site-v2", resources: { cpu: 4, memory: 8 } }).open(
        "site",
      )
    ).run("ls");
    expect(own.calls.builds).toEqual([
      { ref: "locus-site-v2", opts: expect.objectContaining({ cpuCount: 4, memoryMB: 8192 }) },
    ]);
  });

  it("says plainly when a site's sandbox is too small, instead of letting its install be killed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = e2b();
    // A template someone built small by hand.
    await Template.build({} as never, "small", { cpuCount: 2, memoryMB: 1024 } as never);
    await expect(provider(fake, { templateName: "small" }).open("site")).rejects.toThrow(
      "This site's preview sandbox is too small to install the site (it has 2 CPUs and 0.9 GB of memory; a site needs at least 2 and 4). Otaku needs to fix it; trying again won't help.",
    );
    expect(callerCommands(fake.vmOf("site"))).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(sandboxName("site")));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("E2B_TEMPLATE"));
    error.mockRestore();
  });

  it("gives commands only Locus's fixed environment", async () => {
    const fake = e2b();
    const runtime = await provider(fake).open("site");
    await runtime.run("ls");
    await runtime.install();
    const [run, install] = callerCommands(fake.vmOf("site"));
    expect(run).toBe("'ls'");
    expect(install).toMatch(/^'sh' -c /);
  });

  it("quotes the command, so it runs as one program and never as shell syntax", async () => {
    const fake = e2b();
    const runtime = await provider(fake).open("site");
    await runtime.run("echo hi; touch /tmp/pwned", ["a b"]);
    const [command] = callerCommands(fake.vmOf("site"));
    expect(command).toBe(`'echo hi; touch /tmp/pwned' 'a b'`);
  });

  it("reuses the sandbox in-process, and finds it again by name from a new process", async () => {
    const fake = e2b();
    const runtimes = provider(fake);
    const a = await runtimes.open("site");
    const b = await runtimes.open("site");
    expect(a).toBe(b);
    await provider(fake).open("site");
    expect(fake.calls.created).toHaveLength(1);
  });

  it("pushes the pause back on every call, so a sandbox in use isn't paused under it", async () => {
    const fake = e2b();
    const runtime = await provider(fake, { idleMinutes: 20 }).open("site");
    await runtime.run("ls");
    const vm = fake.vmOf("site");
    expect(vm?.timeouts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(vm?.timeouts)).toEqual(new Set([20 * 60_000]));
  });

  it("seeds a new sandbox once, before anyone else gets it", async () => {
    const fake = e2b();
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
    await vi.waitFor(() => expect(order).toContain("seed:start"));
    expect(order).not.toContain("first:open");
    release();
    await first;
    expect(order.indexOf("seed:done")).toBeLessThan(order.indexOf("first:open"));
    expect(fake.vmOf("site")?.files.has(MARKER)).toBe(true);
    expect(fake.vmOf("site")?.files.get(`${ROOT}/package.json`)).toBe("{}");

    // Opened again from a new process: already seeded, so not seeded again.
    await provider(fake, { onCreate }).open("site");
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("runs a failed seeding again on the next open", async () => {
    const fake = e2b();
    const onCreate = vi
      .fn<(key: string, runtime: SiteRuntime) => Promise<void>>()
      .mockRejectedValueOnce(new Error("seeding broke"))
      .mockResolvedValue(undefined);
    const runtimes = provider(fake, { onCreate });
    await expect(runtimes.open("site")).rejects.toThrow(/seeding broke/);
    expect(fake.vmOf("site")?.files.has(MARKER)).toBe(false);
    await runtimes.open("site");
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(fake.vmOf("site")?.files.has(MARKER)).toBe(true);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("resumes a sandbox E2B paused while idle, with its files, and doesn't seed it again", async () => {
    const fake = e2b();
    const onCreate = vi.fn(async () => {});
    const runtime = await provider(fake, { onCreate }).open("site");
    await runtime.writeFiles([{ path: "a.txt", content: "kept" }]);
    const vm = fake.vmOf("site") as FakeVm;
    vm.state = "paused"; // E2B's timeout, unseen by this process

    const result = await runtime.run("ls");
    expect(result.exitCode).toBe(0);
    expect(fake.calls.connected).toContain(vm.sandboxId);
    expect(vm.files.get(`${ROOT}/a.txt`)).toBe("kept");
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("recreates and reseeds a sandbox that was deleted under it", async () => {
    const fake = e2b();
    const onCreate = vi.fn(async () => {});
    const runtime = await provider(fake, { onCreate }).open("site");
    const old = fake.vmOf("site") as FakeVm;
    fake.vms.delete(old.sandboxId);
    old.state = "killed";

    await runtime.run("ls");
    expect(fake.calls.created).toHaveLength(2);
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(fake.vmOf("site")?.files.has(MARKER)).toBe(true);
  });

  it("writes files under the project root and refuses unsafe paths", async () => {
    const fake = e2b();
    const runtime = await provider(fake).open("site");
    await runtime.writeFiles([
      { path: "app/blog/page.tsx", content: "x" },
      { path: "public/logo.png", content: new Uint8Array([65, 66]) },
    ]);
    const vm = fake.vmOf("site") as FakeVm;
    expect(vm.files.get(`${ROOT}/app/blog/page.tsx`)).toBe("x");
    expect(vm.files.get(`${ROOT}/public/logo.png`)).toBe("AB");
    expect(callerCommands(vm)[0]).toBe(`'mkdir' -p -- ${ROOT}/app/blog ${ROOT}/public`);
    await expect(runtime.writeFiles([{ path: "../escape", content: "" }])).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    await expect(runtime.deleteFiles(["/etc/passwd"])).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("keeps only a bounded tail of command output, and a failed command's output", async () => {
    const fake = e2b((command) =>
      command.includes("noisy")
        ? { stdout: "x".repeat(500), stderr: "e".repeat(10) }
        : command.includes("broken")
          ? { exitCode: 2, stderr: "Module not found" }
          : undefined,
    );
    const runtime = await provider(fake, { maxOutputChars: 100 }).open("site");
    const result = await runtime.run("noisy");
    expect(result.stdout).toMatch(/^\[\.\.\. 400 characters truncated \.\.\.\]\nx{100}$/);
    expect(result.stderr).toBe("e".repeat(10));
    expect(await runtime.run("broken")).toMatchObject({ exitCode: 2, timedOut: false });
    expect((await runtime.run("broken")).stderr).toContain("Module not found");
  });

  it("reports a command cut at its timeout", async () => {
    const fake = e2b((command) => (command.includes("slow") ? { delayMs: 200 } : {}));
    const runtime = await provider(fake).open("site");
    const result = await runtime.run("slow", [], { timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("shares one install between concurrent calls in this process", async () => {
    const fake = e2b((command) =>
      command.includes("pnpm install") ? { delayMs: 20, stdout: "installed" } : undefined,
    );
    const runtime = await provider(fake).open("site");
    const [a, b] = await Promise.all([runtime.install(), runtime.install()]);
    expect(a).toBe(b);
    const installs = callerCommands(fake.vmOf("site")).filter((c) => c.includes("pnpm install"));
    expect(installs).toHaveLength(1);
  });

  it("starts next dev once in the background and returns the sandbox's public preview URL", async () => {
    const fake = e2b((command) => {
      if (command.includes("next dev")) return { background: true };
      // Nothing is running yet.
      if (command.includes("locus-preview.pid") && command.includes("kill -0")) {
        return { exitCode: 1 };
      }
      return undefined;
    });
    const runtime = await provider(fake).open("site");
    const urls = await Promise.all([runtime.startPreview(), runtime.startPreview()]);
    const vm = fake.vmOf("site");
    const url = `https://3000-${vm?.sandboxId}.e2b.fake`;
    expect(urls).toEqual([{ url }, { url }]);
    const launches = callerCommands(vm).filter((c) => c.includes("next dev"));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("--port 3000 --hostname 0.0.0.0");
  });

  it("leaves a running dev server alone", async () => {
    const fake = e2b();
    const runtime = await provider(fake).open("site");
    await runtime.startPreview();
    expect(callerCommands(fake.vmOf("site")).some((c) => c.includes("next dev"))).toBe(false);
  });

  it("waits for the dev server, and a dev server that died is not an error", async () => {
    const fake = e2b((command) => {
      if (command.includes("kill -0") && command.includes("grep -q next")) return { exitCode: 1 };
      if (command.includes("next dev")) return { background: true };
      if (command.includes("node -e")) return { exitCode: 2 }; // died while starting
      if (command.includes("tail -c")) return { stdout: "Error: Cannot find module 'next'" };
      return undefined;
    });
    const runtime = await provider(fake, { previewReadyTimeoutMs: 5_000 }).open("site");
    const { url } = await runtime.startPreview();
    expect(url).toMatch(/^https:\/\/3000-sbx\d+\.e2b\.fake$/);
    const probe = callerCommands(fake.vmOf("site")).find((c) => c.includes("node -e"));
    expect(probe).toContain("http://127.0.0.1:3000/");
    expect(await runtime.previewLogs()).toBe("Error: Cannot find module 'next'");
  });

  it("pauses the sandbox on stop, which the next open resumes", async () => {
    const fake = e2b();
    const runtimes = provider(fake);
    const runtime = await runtimes.open("site");
    const vm = fake.vmOf("site") as FakeVm;
    await runtime.stop();
    expect(fake.calls.paused).toEqual([vm.sandboxId]);
    const again = await runtimes.open("site");
    expect(again).not.toBe(runtime);
    expect(fake.calls.connected).toContain(vm.sandboxId);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("deletes a site's sandbox, held or not, and a deleted site's runtime never comes back", async () => {
    const fake = e2b();
    const runtimes = provider(fake);
    const runtime = await runtimes.open("site");
    const first = fake.vmOf("site") as FakeVm;
    await runtimes.destroy("site");
    expect(fake.calls.killed).toEqual([first.sandboxId]);
    await expect(runtime.run("ls")).rejects.toThrow(/deleted/);
    expect(fake.calls.created).toHaveLength(1);

    await provider(fake).open("other");
    const other = fake.vmOf("other") as FakeVm;
    await provider(fake).destroy("other");
    expect(fake.calls.killed).toEqual([first.sandboxId, other.sandboxId]);
    // Nothing there: fine.
    await provider(fake).destroy("never-made");
  });

  it("never recreates a deleted site's sandbox for a call that was under way", async () => {
    const fake = e2b();
    const onCreate = vi.fn(async () => {});
    const runtimes = provider(fake, { onCreate });
    const runtime = await runtimes.open("site");
    const release = fake.holdUploads();
    const writing = runtime.writeFiles([{ path: "lead.txt", content: "a deleted client's data" }]);
    writing.catch(() => {});
    await vi.waitFor(() => expect(fake.calls.held).toBe(1));

    await runtimes.destroy("site");
    release(); // the upload now finds its sandbox gone, and Mastra would start a new one

    await expect(writing).rejects.toThrow(/deleted|not found/);
    expect(fake.calls.created).toHaveLength(1);
    expect(fake.vms.size).toBe(0);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await expect(runtime.run("ls")).rejects.toThrow(/deleted/);
    expect(fake.calls.created).toHaveLength(1);
  });

  it("puts nothing but the site into the sandbox's options", () => {
    const options = e2bOptions("site", { apiKey: API_KEY }, "locus-site-v1", async () => {});
    expect(options).toMatchObject({ id: sandboxName("site"), workingDirectory: ROOT });
    expect(options.env).toBeUndefined();
    expect(posix.isAbsolute(String(options.workingDirectory))).toBe(true);
  });
});

describe("e2bFromEnv", () => {
  it("needs E2B_API_KEY", () => {
    expect(e2bFromEnv({})).toBeNull();
    expect(e2bFromEnv({ E2B_API_KEY: API_KEY })).toBeInstanceOf(E2BRuntimeProvider);
  });
});
