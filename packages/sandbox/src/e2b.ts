/**
 * `RuntimeProvider` on E2B, through Mastra's workspace sandbox (`@mastra/e2b`).
 *
 * Credentials: Otaku's E2B API key, read server-side only (`E2B_API_KEY`). It is given to the E2B
 * client in this process and nothing else: never to the sandbox's or a command's environment,
 * its filesystem, a command's arguments, or the preview URL.
 *
 * Each site gets one E2B sandbox, found again by its name (`locus-site-<hash of key>`, as on
 * Vercel and Daytona) in Mastra's sandbox metadata. Sandboxes come from one Locus template
 * (`templateName`): Mastra's base image with Node and pnpm, built once on first use with the CPU
 * and memory a site's install needs (`resources`). E2B's own default image is smaller.
 *
 * E2B pauses a sandbox when its timeout runs out (`idleMinutes`, renewed on every call) and keeps
 * its files and running processes; opening the preview, or the next call, resumes it with the dev
 * server still running. One that was deleted is recreated empty, and `onCreate` seeds it again.
 *
 * Seeding runs in Mastra's `onStart` hook, which fires on every start, so it also covers a
 * sandbox recreated mid-call. Until it has finished once (`.locus/seeded` in the project root),
 * every start runs it again, and no call gets the runtime before it has finished.
 *
 * Previews are E2B's public URL for the port (`https://<port>-<sandbox id>.e2b.app`), as on
 * Vercel Sandbox: unguessable, no token, no warning page, and no API key in it.
 *
 * The site's draft in Locus stays the source of truth: files reach the sandbox only through
 * `writeFiles` (the builder's sync), never through Mastra's workspace tools, which this module
 * does not expose.
 */
import { posix } from "node:path";
import type { E2BSandbox, E2BSandboxOptions } from "@mastra/e2b";
import { installScript, previewLaunchScript } from "./daytona.ts";
import { DEFAULT_MAX_OUTPUT_CHARS, TailBuffer, truncateTail } from "./output.ts";
import { validatePath } from "./paths.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";
import { sandboxName } from "./vercel.ts";

export interface E2BSandboxConfig {
  /** Otaku's E2B API key. Server-side only; never passed into a sandbox. */
  apiKey: string;
  /** E2B's domain, when not E2B Cloud's `e2b.app` (`E2B_DOMAIN`, a self-hosted E2B). */
  domain?: string;
  /**
   * The E2B template new sandboxes are made from, built on first use when it doesn't exist.
   * Default `locus-site-v1`. Change it (with `resources`) to build a new one; sandboxes made
   * from the old one keep it until they are deleted.
   */
  templateName?: string;
  /**
   * CPU (cores) and memory (GiB) the template is built with, and the least a site's sandbox may
   * run with. Default 2 and 4, as on Vercel Sandbox and Daytona: less and the install is killed.
   * A smaller sandbox is refused with a plain error rather than left to fail its install.
   */
  resources?: { cpu: number; memory: number };
  /**
   * Minutes without a Locus call before E2B pauses a sandbox (it keeps its files and processes,
   * and opening the preview resumes it). Default 15.
   */
  idleMinutes?: number;
  /** Ports the site may serve on. The first one is the preview port. Default `[3000]`. */
  ports?: number[];
  /** Absolute project root inside the sandbox. Default `/home/user/site`. */
  projectRoot?: string;
  /** Default timeout for `run`. Default 5 min. */
  commandTimeoutMs?: number;
  /** Timeout for `install`. Default 10 min. */
  installTimeoutMs?: number;
  /** How long `startPreview` waits for the dev server to answer. Default 90 s; 0 to not wait. */
  previewReadyTimeoutMs?: number;
  /**
   * Hosts the preview URL is served on, which `next dev` must allow as dev origins. Default
   * `*.<domain>` (`E2B_PREVIEW_HOSTS` on E2B Cloud).
   */
  previewHosts?: readonly string[];
  /** Bound on each of stdout, stderr and the preview log. Default 64k characters. */
  maxOutputChars?: number;
  /** Prefix of sandbox names. Default `locus-site-`. */
  namePrefix?: string;
  /**
   * Called after a site's sandbox was created empty (or an earlier seeding didn't finish),
   * before the call that triggered it continues.
   */
  onCreate?: (key: string, runtime: SiteRuntime) => Promise<void>;
  /**
   * Builds the Mastra sandbox for a site. Tests pass a fake; the default is
   * `new E2BSandbox(options)` from `@mastra/e2b`.
   */
  createSandbox?: (options: E2BSandboxOptions) => E2BSandbox | Promise<E2BSandbox>;
}

type Template = NonNullable<E2BSandboxOptions["template"]>;

const E2B_DOMAIN = "e2b.app";

/** The hosts E2B Cloud serves preview URLs on (`https://<port>-<sandbox id>.e2b.app`). */
export const E2B_PREVIEW_HOSTS: readonly string[] = [`*.${E2B_DOMAIN}`];

const DEFAULTS = {
  templateName: "locus-site-v1",
  resources: { cpu: 2, memory: 4 },
  idleMinutes: 15,
  ports: [3000],
  projectRoot: "/home/user/site",
  commandTimeoutMs: 5 * 60_000,
  installTimeoutMs: 10 * 60_000,
  previewReadyTimeoutMs: 90_000,
  namePrefix: "locus-site-",
};

/** A sandbox's memory as the VM reports it is a little under what it was built with. */
const MEMORY_SLACK_GIB = 0.5;

/** The only environment commands get. Never add credentials here. */
const COMMAND_ENV: Record<string, string> = { NEXT_TELEMETRY_DISABLED: "1" };

/**
 * A command's whole environment, typed as Mastra's options want it. Exactly these variables:
 * nothing from this process's own environment is added.
 */
const commandEnv = (env: Record<string, string>) => ({ ...env }) as NodeJS.ProcessEnv;

const PREVIEW_PID = "/tmp/locus-preview.pid";
const PREVIEW_LOG = "/tmp/locus-preview.log";
/** Written under the project root once `onCreate` has completed for a sandbox. */
const SEED_MARKER = ".locus/seeded";
/** E2B's error for a command cut at its timeout, which Mastra passes on in stderr. */
const TIMED_OUT = /exceeding 'timeoutMs'/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Reads `E2B_API_KEY` (and optionally `E2B_DOMAIN`, `E2B_TEMPLATE`). Null without the key. */
export function e2bFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<E2BSandboxConfig> = {},
): E2BRuntimeProvider | null {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) return null;
  return new E2BRuntimeProvider({
    ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}),
    ...(env.E2B_TEMPLATE ? { templateName: env.E2B_TEMPLATE } : {}),
    ...overrides,
    apiKey,
  });
}

async function defaultCreateSandbox(options: E2BSandboxOptions): Promise<E2BSandbox> {
  const { E2BSandbox } = await import("@mastra/e2b");
  return new E2BSandbox(options);
}

export class E2BRuntimeProvider implements RuntimeProvider {
  private readonly config: E2BSandboxConfig;
  private readonly runtimes = new Map<string, E2BSiteRuntime>();

  constructor(config: E2BSandboxConfig) {
    if (!config.apiKey) throw new Error("E2BRuntimeProvider needs an API key");
    const ports = config.ports ?? DEFAULTS.ports;
    if (ports.length === 0) throw new Error("E2BRuntimeProvider needs at least one port");
    this.config = config;
  }

  async open(key: string): Promise<SiteRuntime> {
    if (!key) throw new Error("open() needs a site key");
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = new E2BSiteRuntime(key, this.config, () => {
        if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);
      });
      this.runtimes.set(key, runtime);
    }
    try {
      await runtime.ready();
    } catch (error) {
      if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);
      throw error;
    }
    return runtime;
  }

  /**
   * Deletes the site's sandbox and its files for good. A sandbox that's already gone is fine. A
   * runtime this process still holds for the site is marked deleted first, so a call already
   * under way can't recreate it.
   */
  async destroy(key: string): Promise<void> {
    if (!key) throw new Error("destroy() needs a site key");
    const held = this.runtimes.get(key);
    this.runtimes.delete(key);
    if (held) {
      await held.destroy();
      return;
    }
    await destroyDetached(key, this.config);
  }
}

/**
 * The template spec Mastra builds once and then reuses by name: its base image (Node and pnpm
 * through corepack) at `resources`. No fallback: a template that can't be built fails plainly
 * instead of falling back to a smaller machine whose install would be killed.
 */
async function templateSpec(config: E2BSandboxConfig): Promise<Template> {
  const { createDefaultMountableTemplate } = await import("@mastra/e2b");
  const want = config.resources ?? DEFAULTS.resources;
  const resources = { cpuCount: want.cpu, memoryMB: want.memory * 1024 };
  const { template } = createDefaultMountableTemplate(resources);
  return {
    ref: config.templateName ?? DEFAULTS.templateName,
    template,
    buildResources: resources,
    fallbackTemplate: false,
  };
}

/** The Mastra sandbox options for a site. Nothing here may carry a credential into the VM. */
export function e2bOptions(
  key: string,
  config: E2BSandboxConfig,
  template: Template,
  onStart: NonNullable<E2BSandboxOptions["onStart"]>,
): E2BSandboxOptions {
  return {
    id: sandboxName(key, config.namePrefix ?? DEFAULTS.namePrefix),
    apiKey: config.apiKey,
    ...(config.domain ? { domain: config.domain } : {}),
    template,
    // The sandbox's own timeout: E2B pauses it when this runs out (renewed on every call).
    timeout: (config.idleMinutes ?? DEFAULTS.idleMinutes) * 60_000,
    // Paused, not killed, and woken again by the preview's own traffic.
    lifecycle: { onTimeout: "pause", autoResume: true },
    metadata: { app: "locus" },
    workingDirectory: config.projectRoot ?? DEFAULTS.projectRoot,
    onStart,
  };
}

async function buildSandbox(
  key: string,
  config: E2BSandboxConfig,
  onStart: NonNullable<E2BSandboxOptions["onStart"]>,
): Promise<E2BSandbox> {
  const options = e2bOptions(key, config, await templateSpec(config), onStart);
  return (config.createSandbox ?? defaultCreateSandbox)(options);
}

/**
 * Makes `sandbox` refuse to find or create an E2B sandbox once `refused()` holds (the site was
 * deleted), so a call already in flight whose sandbox vanished can't recreate it. Wraps Mastra's
 * `find` and `create` acquisition steps, which every start goes through.
 */
function refuseCreateWhen(sandbox: E2BSandbox, refused: () => boolean): E2BSandbox {
  type Step = (options?: unknown) => Promise<unknown>;
  const acquiring = sandbox as unknown as { find: Step; create: Step };
  for (const step of ["find", "create"] as const) {
    const original = acquiring[step].bind(sandbox);
    acquiring[step] = async (options) => {
      if (refused()) throw new Error("This site was deleted.");
      return original(options);
    };
  }
  return sandbox;
}

/** Looks the site's sandbox up by name without resuming it, and deletes it if it exists. */
async function destroyDetached(key: string, config: E2BSandboxConfig): Promise<void> {
  const sandbox = await buildSandbox(key, config, async () => {});
  await sandbox.destroy();
}

class E2BSiteRuntime implements SiteRuntime {
  readonly id: string;
  readonly previewHosts: readonly string[];
  readonly key: string;
  private readonly config: E2BSandboxConfig;
  private readonly onStop: () => void;
  /** Set for the view handed to `onCreate`: it runs while seeding, so it skips the seed gate. */
  private readonly pinned: E2BSandbox | null;
  private sandbox: Promise<E2BSandbox> | null = null;
  /** Set while the start hook seeds the sandbox; every other call waits for it. */
  private seeding: Promise<void> | null = null;
  private installing: Promise<CommandResult> | null = null;
  private previewStart: Promise<{ url: string }> | null = null;
  /** Set when the site was deleted: this runtime never starts or recreates a sandbox again. */
  private destroyed = false;

  constructor(
    key: string,
    config: E2BSandboxConfig,
    onStop: () => void,
    pinned: E2BSandbox | null = null,
  ) {
    this.key = key;
    this.config = config;
    this.onStop = onStop;
    this.pinned = pinned;
    this.id = sandboxName(key, config.namePrefix ?? DEFAULTS.namePrefix);
    this.previewHosts =
      config.previewHosts ?? (config.domain ? [`*.${config.domain}`] : E2B_PREVIEW_HOSTS);
  }

  private get root(): string {
    return this.config.projectRoot ?? DEFAULTS.projectRoot;
  }
  private get previewPort(): number {
    return (this.config.ports ?? DEFAULTS.ports)[0] ?? 3000;
  }
  private get maxOutput(): number {
    return this.config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }
  private get idleMs(): number {
    return (this.config.idleMinutes ?? DEFAULTS.idleMinutes) * 60_000;
  }

  async ready(): Promise<void> {
    await this.ensure();
  }

  /** The Mastra sandbox, started (or resumed) and seeded, with its pause timer renewed. */
  private async ensure(): Promise<E2BSandbox> {
    if (this.destroyed) throw new Error("This site was deleted.");
    if (this.pinned) return this.pinned;
    if (!this.sandbox) {
      const built = buildSandbox(this.key, this.config, (args) => this.onStart(args)).then(
        (sandbox) => refuseCreateWhen(sandbox, () => this.destroyed),
      );
      this.sandbox = built;
      built.catch(() => {
        if (this.sandbox === built) this.sandbox = null;
      });
    }
    const sandbox = await this.sandbox;
    // Coalesced by Mastra; resolves once the start hook (seeding) has finished.
    await sandbox.start();
    // A start triggered elsewhere (a restart under another call) may be seeding right now.
    while (this.seeding) await this.seeding;
    if (this.destroyed) {
      // Started (maybe recreated) while the site was being deleted: delete it again.
      await sandbox.destroy().catch(() => {});
      throw new Error("This site was deleted.");
    }
    await this.renew(sandbox);
    return sandbox;
  }

  /**
   * Pushes the pause back to `idleMinutes` from now, so a sandbox in use isn't paused under it.
   * Not fatal: E2B caps how long a sandbox runs without a pause (an hour on its free plan), and a
   * paused one is resumed by the next call or by the preview's traffic.
   */
  private async renew(sandbox: E2BSandbox): Promise<void> {
    try {
      await sandbox.e2b.setTimeout(this.idleMs);
    } catch (error) {
      console.warn(
        `E2B sandbox ${this.id}: couldn't push its pause back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Mastra's start hook: on every start, make the project root and seed it if never done. A
   * start after the site was deleted (a restart under a call already in flight) deletes whatever
   * it reached and fails, so a deleted client's files are never seeded anywhere again.
   */
  private onStart({ sandbox }: { sandbox: unknown; outcome?: "created" | "connected" }) {
    if (this.destroyed) {
      return (sandbox as E2BSandbox)
        .destroy()
        .catch(() => {})
        .then(() => {
          throw new Error("This site was deleted.");
        });
    }
    const seeding = this.seed(sandbox as E2BSandbox);
    this.seeding = seeding;
    return seeding.finally(() => {
      if (this.seeding === seeding) this.seeding = null;
    });
  }

  private async seed(sandbox: E2BSandbox): Promise<void> {
    const marker = posix.join(this.root, SEED_MARKER);
    const folders = `${shellQuote(this.root)} ${shellQuote(posix.dirname(marker))}`;
    // Prints the CPUs and memory (kB), then exits 0 if the sandbox was seeded before.
    const check = await sandbox.executeCommand?.(
      "sh",
      [
        "-c",
        `mkdir -p ${folders} && echo "$(nproc) $(awk '/^MemTotal:/ {print $2}' /proc/meminfo)" && test -f ${shellQuote(marker)}`,
      ],
      { cwd: "/", env: commandEnv(COMMAND_ENV), timeout: 60_000 },
    );
    if (!check) throw new Error("This E2B sandbox can't run commands.");
    if (check.exitCode !== 0 && check.exitCode !== 1) {
      throw new Error(`Preparing the sandbox failed (exit ${check.exitCode}): ${check.stderr}`);
    }
    this.checkSize(check.stdout);
    if (check.exitCode === 0) return;
    const onCreate = this.config.onCreate;
    if (onCreate) {
      await onCreate(this.key, new E2BSiteRuntime(this.key, this.config, () => {}, sandbox));
    }
    if (this.destroyed) throw new Error("This site was deleted.");
    await sandbox.writeFiles([{ path: marker, content: new Date().toISOString() }]);
  }

  /** Refuses a sandbox smaller than `resources`: its install would be killed. */
  private checkSize(printed: string): void {
    const want = this.config.resources ?? DEFAULTS.resources;
    const [cpuText, memoryKb] = printed.trim().split(/\s+/);
    const cpu = Number(cpuText);
    const memory = Number(memoryKb) / 1024 / 1024;
    if (!Number.isFinite(cpu) || !Number.isFinite(memory)) {
      throw new Error(`Couldn't read this sandbox's size: ${printed.trim().slice(0, 200)}`);
    }
    if (cpu >= want.cpu && memory >= want.memory - MEMORY_SLACK_GIB) return;
    const shown = Math.round(memory * 10) / 10;
    // The details are for Otaku; the error reaches the site builder and the agency.
    console.error(
      `E2B sandbox ${this.id} has ${cpu} CPUs and ${shown} GB of memory, under ${want.cpu} and ${want.memory}: its template (E2B_TEMPLATE) was built smaller, or the E2B plan doesn't allow that size.`,
    );
    throw new Error(
      `This site's preview sandbox is too small to install the site (it has ${cpu} CPUs and ${shown} GB of memory; a site needs at least ${want.cpu} and ${want.memory}). Otaku needs to fix it; trying again won't help.`,
    );
  }

  /** Runs `fn` on the started sandbox, once more if the sandbox died under it. */
  private async use<T>(fn: (sandbox: E2BSandbox) => Promise<T>): Promise<T> {
    const sandbox = await this.ensure();
    return sandbox.retryOnDead(() => fn(sandbox));
  }

  /** Runs a command and streams its output into bounded tails. */
  private async exec(
    command: string,
    args: string[],
    timeoutMs: number,
    env: Record<string, string> = COMMAND_ENV,
  ): Promise<CommandResult> {
    const sandbox = await this.ensure();
    const stdout = new TailBuffer(this.maxOutput);
    const stderr = new TailBuffer(this.maxOutput);
    if (!sandbox.executeCommand) throw new Error("This E2B sandbox can't run commands.");
    // Mastra joins the command and its quoted args into one shell line: quote the command too,
    // so it is one program, as on Vercel, and never shell syntax.
    const result = await sandbox.executeCommand(shellQuote(command), args, {
      cwd: this.root,
      env: commandEnv(env),
      timeout: timeoutMs,
      onStdout: (data) => stdout.push(data),
      onStderr: (data) => stderr.push(data),
      maxRetainedBytes: 0,
    });
    // A command E2B cut or lost ends in an error whose message Mastra adds to stderr, not streamed.
    if (result.stderr && !stderr.toString()) stderr.push(result.stderr);
    return {
      exitCode: result.exitCode,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      timedOut: result.timedOut === true || TIMED_OUT.test(result.stderr),
    };
  }

  async writeFiles(files: RuntimeFile[]): Promise<void> {
    if (files.length === 0) return;
    const checked = files.map((file) => ({
      path: posix.join(this.root, validatePath(file.path)),
      content: typeof file.content === "string" ? file.content : Buffer.from(file.content),
    }));
    const dirs = [...new Set(checked.map((file) => posix.dirname(file.path)))];
    const made = await this.exec(
      "mkdir",
      ["-p", "--", ...dirs],
      this.config.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    );
    if (made.exitCode !== 0) {
      throw new Error(`Writing files failed (exit ${made.exitCode}): ${made.stderr}`);
    }
    await this.use((sandbox) => sandbox.writeFiles(checked));
  }

  async deleteFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const checked = paths.map(validatePath);
    const result = await this.exec(
      "rm",
      ["-rf", "--", ...checked],
      this.config.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Deleting files failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  async run(
    command: string,
    args: string[] = [],
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    if (!command) throw new Error("run() needs a command");
    return this.exec(
      command,
      args,
      opts.timeoutMs ?? this.config.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    );
  }

  /**
   * Installs when `package.json` or a lockfile changed since the last successful install.
   * Concurrent calls in this process share one install; across processes a lock in the sandbox
   * makes the second wait and then find the stamp current.
   */
  install(opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
    if (!this.installing) {
      this.installing = this.doInstall(opts).finally(() => {
        this.installing = null;
      });
    }
    return this.installing;
  }

  private doInstall(opts: { timeoutMs?: number }): Promise<CommandResult> {
    return this.exec(
      "sh",
      ["-c", installScript()],
      opts.timeoutMs ?? this.config.installTimeoutMs ?? DEFAULTS.installTimeoutMs,
      { ...COMMAND_ENV, CI: "1" },
    );
  }

  private async previewRunning(): Promise<boolean> {
    // A pid file kept across a pause can name an unrelated process, so check it is `next`.
    const script = `pid=$(cat ${PREVIEW_PID} 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q next "/proc/$pid/cmdline" 2>/dev/null`;
    const result = await this.exec("sh", ["-c", script], 30_000);
    return result.exitCode === 0;
  }

  /** Concurrent calls share one start, so two `next dev` never race for the port. */
  startPreview(): Promise<{ url: string }> {
    if (!this.previewStart) {
      this.previewStart = this.doStartPreview().finally(() => {
        this.previewStart = null;
      });
    }
    return this.previewStart;
  }

  private async doStartPreview(): Promise<{ url: string }> {
    const port = this.previewPort;
    if (!(await this.previewRunning())) {
      const script = previewLaunchScript(port);
      await this.use(async (sandbox) => {
        // In the background, outliving this call: no timeout, and its output goes to the log
        // file (`previewLogs`), so none is held here.
        await sandbox.processes.spawn(`sh -c ${shellQuote(script)}`, {
          cwd: this.root,
          env: commandEnv(COMMAND_ENV),
          timeout: 0,
          maxRetainedBytes: 0,
          stdinMode: "ignore",
        });
      });
      await this.waitForPreview(port);
    }
    const host = await this.use(async (sandbox) => sandbox.e2b.getHost(port));
    return { url: `https://${host}` };
  }

  /**
   * Waits until the dev server answers or dies. Not being ready is not an error: the reason is
   * in the preview log, which the caller reads.
   */
  private async waitForPreview(port: number): Promise<void> {
    const waitMs = this.config.previewReadyTimeoutMs ?? DEFAULTS.previewReadyTimeoutMs;
    if (waitMs <= 0) return;
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    const probe = `fetch("http://127.0.0.1:${port}/").then(() => process.exit(0), () => process.exit(1))`;
    const script = [
      `i=0`,
      `while [ "$i" -lt ${seconds} ]; do`,
      `  node -e ${shellQuote(probe)} && exit 0`,
      `  kill -0 "$(cat ${PREVIEW_PID} 2>/dev/null)" 2>/dev/null || exit 2`,
      `  sleep 1; i=$((i + 1))`,
      `done`,
      `exit 1`,
    ].join("\n");
    await this.exec("sh", ["-c", script], waitMs + 30_000);
  }

  async previewLogs(): Promise<string> {
    const result = await this.exec(
      "sh",
      ["-c", `tail -c ${this.maxOutput} ${PREVIEW_LOG} 2>/dev/null || true`],
      30_000,
    );
    return truncateTail(result.stdout, this.maxOutput);
  }

  async stop(): Promise<void> {
    this.onStop();
    const sandbox = await this.sandbox?.catch(() => null);
    this.sandbox = null;
    if (!sandbox) return;
    // E2B pauses it, keeping its files and processes; the next open resumes it.
    await sandbox._stop();
  }

  /** The site was deleted: never start again, and delete the sandbox. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    const sandbox = await this.sandbox?.catch(() => null);
    this.sandbox = null;
    if (!sandbox) {
      await destroyDetached(this.key, this.config);
      return;
    }
    // Mastra's own delete (found by name even if this process never started it), then marked
    // destroyed so its lazy start refuses; a restart under a call in flight still meets the
    // `create` guard and the start hook.
    await sandbox.destroy();
    sandbox.status = "destroyed";
  }
}
