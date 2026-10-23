/**
 * `RuntimeProvider` on Daytona, through Mastra's workspace sandbox (`@mastra/daytona`).
 *
 * Credentials: Otaku's Daytona API key, read server-side only (`DAYTONA_API_KEY`). It is given to
 * the Daytona client in this process and nothing else: never to the sandbox's or a command's
 * environment, its filesystem, a command's arguments, or the preview URL.
 *
 * Each site gets one named Daytona sandbox (`locus-site-<hash of key>`, as on Vercel). Daytona
 * stops an idle sandbox and keeps its filesystem; the next call starts it again (Mastra's
 * `retryOnDead` restarts one that stopped under a running call). One that was deleted or broke
 * is recreated empty, and `onCreate` seeds it again.
 *
 * Seeding runs in Mastra's `onStart` hook, which fires on every start, so it also covers a
 * sandbox recreated mid-call. Until it has finished once (`.locus/seeded` in the project root),
 * every start runs it again, and no call gets the runtime before it has finished.
 *
 * Previews are private (never `public: true`): the URL the browser gets is Daytona's signed
 * preview URL for the port, which expires (`previewUrlTtlSeconds`) and carries no API key. A Locus
 * proxy that adds the preview token itself can replace it through `previewUrl`.
 *
 * The site's draft in Locus stays the source of truth: files reach the sandbox only through
 * `writeFiles` (the builder's sync), never through Mastra's workspace tools, which this module
 * does not expose.
 */
import { posix } from "node:path";
import type { DaytonaSandbox, DaytonaSandboxOptions } from "@mastra/daytona";
import { DEFAULT_MAX_OUTPUT_CHARS, TailBuffer, truncateTail } from "./output.ts";
import { validatePath } from "./paths.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";
import { sandboxName } from "./vercel.ts";

export interface DaytonaSandboxConfig {
  /** Otaku's Daytona API key. Server-side only; never passed into a sandbox. */
  apiKey: string;
  /** Daytona's API, when not the default (`DAYTONA_API_URL`). */
  apiUrl?: string;
  /** Daytona region (`DAYTONA_TARGET`). */
  target?: string;
  /** A Daytona snapshot to create sandboxes from, instead of Daytona's default. */
  snapshot?: string;
  /**
   * Domains the sandbox may reach (Daytona's egress allowlist), e.g.
   * `registry.npmjs.org,fonts.gstatic.com`. Unset leaves egress open, as on Vercel today.
   * Applies to sandboxes created after it is set.
   */
  domainAllowList?: string;
  /** Minutes of inactivity before Daytona stops a sandbox (it keeps its files). Default 30. */
  autoStopMinutes?: number;
  /** Ports the site may serve on. The first one is the preview port. Default `[3000]`. */
  ports?: number[];
  /** Absolute project root inside the sandbox. Default `/home/daytona/site`. */
  projectRoot?: string;
  /** Default timeout for `run`. Default 5 min. */
  commandTimeoutMs?: number;
  /** Timeout for `install`. Default 10 min. */
  installTimeoutMs?: number;
  /** How long `startPreview` waits for the dev server to answer. Default 90 s; 0 to not wait. */
  previewReadyTimeoutMs?: number;
  /** How long a signed preview URL stays valid. Default 6 h. */
  previewUrlTtlSeconds?: number;
  /**
   * The URL the browser opens for the preview, instead of Daytona's signed preview URL: the seam
   * for a Locus proxy that holds the preview token. Gets the started sandbox and the port.
   */
  previewUrl?: (sandbox: DaytonaSandbox, port: number) => Promise<string>;
  /**
   * Hosts the preview URL is served on, which `next dev` must allow as dev origins. Default
   * `DAYTONA_PREVIEW_HOSTS` (Daytona Cloud's proxy); set it with `previewUrl`, another region's
   * proxy or a self-hosted Daytona.
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
   * Builds the Mastra sandbox for a site. Tests pass one whose Daytona client is a fake; the
   * default is `new DaytonaSandbox(options)` from `@mastra/daytona`.
   */
  createSandbox?: (options: DaytonaSandboxOptions) => DaytonaSandbox | Promise<DaytonaSandbox>;
}

/**
 * The hosts Daytona Cloud serves preview URLs on (`https://<port>-<id or token>.proxy.daytona.works`),
 * signed or not.
 */
export const DAYTONA_PREVIEW_HOSTS: readonly string[] = ["*.proxy.daytona.works"];

const DEFAULTS = {
  autoStopMinutes: 30,
  ports: [3000],
  projectRoot: "/home/daytona/site",
  commandTimeoutMs: 5 * 60_000,
  installTimeoutMs: 10 * 60_000,
  previewReadyTimeoutMs: 90_000,
  previewUrlTtlSeconds: 6 * 60 * 60,
  namePrefix: "locus-site-",
};

/** The only environment commands get. Never add credentials here. */
const COMMAND_ENV: Record<string, string> = { NEXT_TELEMETRY_DISABLED: "1" };

/**
 * A command's whole environment, typed as Mastra's options want it. Exactly these variables:
 * nothing from this process's own environment is added.
 */
const commandEnv = (env: Record<string, string>) => ({ ...env }) as NodeJS.ProcessEnv;

const PREVIEW_PID = "/tmp/locus-preview.pid";
const PREVIEW_LOG = "/tmp/locus-preview.log";
/** Held by the running dev server, so a second start (from another process) backs off. */
const PREVIEW_LOCK = "/tmp/locus-preview.lock";
/** Held while installing, so two installs (from two processes) never run at once. */
const INSTALL_LOCK = "/tmp/locus-install.lock";
const INSTALL_STAMP = "node_modules/.locus-install-stamp";
/** Written under the project root once `onCreate` has completed for a sandbox. */
const SEED_MARKER = ".locus/seeded";
/** pnpm for an image that doesn't ship it; the version Locus itself is built with. */
const PNPM_FALLBACK = "npx --yes pnpm@10.28.0";
/** The exit code Mastra's Daytona process handle reports for a command it cut at its timeout. */
const TIMED_OUT_EXIT = 124;

/** Where the scripts below keep their locks and state in the sandbox; tests point them elsewhere. */
export interface SandboxScriptPaths {
  installLock: string;
  previewLock: string;
  previewPid: string;
  previewLog: string;
}

const SCRIPT_PATHS: SandboxScriptPaths = {
  installLock: INSTALL_LOCK,
  previewLock: PREVIEW_LOCK,
  previewPid: PREVIEW_PID,
  previewLog: PREVIEW_LOG,
};

/**
 * Installs in the project root (the cwd) when `package.json` or a lockfile changed since the
 * last successful install. It takes the install lock first and only then compares the stamp, so a
 * second install (another process) waits for the first and then finds nothing to do.
 */
export function installScript(paths: SandboxScriptPaths = SCRIPT_PATHS): string {
  const digest = `{ cat package.json; cat pnpm-lock.yaml 2>/dev/null; cat package-lock.json 2>/dev/null; } | sha256sum | cut -d' ' -f1`;
  return [
    `[ -f package.json ] || { echo "package.json not found" >&2; exit 1; }`,
    `if command -v flock >/dev/null 2>&1; then exec 9>${shellQuote(paths.installLock)}; flock 9; fi`,
    `sum=$(${digest})`,
    `if [ -f ${INSTALL_STAMP} ] && [ "$(cat ${INSTALL_STAMP})" = "$sum" ]; then echo "dependencies up to date"; exit 0; fi`,
    `if [ -f package-lock.json ] && [ ! -f pnpm-lock.yaml ]; then npm install`,
    `elif command -v pnpm >/dev/null 2>&1; then pnpm install`,
    `else ${PNPM_FALLBACK} install; fi`,
    `code=$?`,
    `if [ "$code" -eq 0 ]; then mkdir -p node_modules && ${digest} > ${INSTALL_STAMP}; fi`,
    `exit "$code"`,
  ].join("\n");
}

/**
 * Starts `next dev` from the project root (the cwd). This shell holds the preview lock for as
 * long as the dev server runs and waits on it, so a start from another process (the web app and
 * the agent server share sandboxes) finds it taken, exits 0 and leaves the running one alone. The
 * dev server itself gets the lock's descriptor closed, so a process it leaves behind can never
 * keep the lock once it has died; the pid file names the dev server.
 */
export function previewLaunchScript(
  port: number,
  paths: SandboxScriptPaths = SCRIPT_PATHS,
): string {
  return [
    `exec 9>${shellQuote(paths.previewLock)}`,
    `if command -v flock >/dev/null 2>&1; then flock -n 9 || exit 0; fi`,
    `./node_modules/.bin/next dev --port ${port} --hostname 0.0.0.0 > ${shellQuote(paths.previewLog)} 2>&1 9>&- &`,
    `echo $! > ${shellQuote(paths.previewPid)}`,
    `wait $!`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Reads `DAYTONA_API_KEY` (and optionally `DAYTONA_API_URL`, `DAYTONA_TARGET`,
 * `DAYTONA_SNAPSHOT`, `LOCUS_SANDBOX_EGRESS`). Null without the key.
 */
export function daytonaFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<DaytonaSandboxConfig> = {},
): DaytonaRuntimeProvider | null {
  const apiKey = env.DAYTONA_API_KEY;
  if (!apiKey) return null;
  return new DaytonaRuntimeProvider({
    ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
    ...(env.DAYTONA_SNAPSHOT ? { snapshot: env.DAYTONA_SNAPSHOT } : {}),
    ...(env.LOCUS_SANDBOX_EGRESS ? { domainAllowList: env.LOCUS_SANDBOX_EGRESS } : {}),
    ...overrides,
    apiKey,
  });
}

async function defaultCreateSandbox(options: DaytonaSandboxOptions): Promise<DaytonaSandbox> {
  const { DaytonaSandbox } = await import("@mastra/daytona");
  return new DaytonaSandbox(options);
}

export class DaytonaRuntimeProvider implements RuntimeProvider {
  private readonly config: DaytonaSandboxConfig;
  private readonly runtimes = new Map<string, DaytonaSiteRuntime>();

  constructor(config: DaytonaSandboxConfig) {
    if (!config.apiKey) throw new Error("DaytonaRuntimeProvider needs an API key");
    const ports = config.ports ?? DEFAULTS.ports;
    if (ports.length === 0) throw new Error("DaytonaRuntimeProvider needs at least one port");
    this.config = config;
  }

  async open(key: string): Promise<SiteRuntime> {
    if (!key) throw new Error("open() needs a site key");
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = new DaytonaSiteRuntime(key, this.config, () => {
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

/** The Mastra sandbox options for a site. Nothing here may carry a credential into the VM. */
export function daytonaOptions(
  key: string,
  config: DaytonaSandboxConfig,
  onStart: NonNullable<DaytonaSandboxOptions["onStart"]>,
): DaytonaSandboxOptions {
  const name = sandboxName(key, config.namePrefix ?? DEFAULTS.namePrefix);
  return {
    id: name,
    name,
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    ...(config.target ? { target: config.target } : {}),
    ...(config.snapshot ? { snapshot: config.snapshot } : {}),
    ...(config.domainAllowList ? { domainAllowList: config.domainAllowList } : {}),
    language: "typescript",
    // Private: a preview needs Daytona's token, which stays with Locus or in a signed URL.
    public: false,
    autoStopInterval: config.autoStopMinutes ?? DEFAULTS.autoStopMinutes,
    labels: { app: "locus" },
    workingDirectory: config.projectRoot ?? DEFAULTS.projectRoot,
    timeout: config.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    onStart,
  };
}

async function buildSandbox(
  key: string,
  config: DaytonaSandboxConfig,
  onStart: NonNullable<DaytonaSandboxOptions["onStart"]>,
): Promise<DaytonaSandbox> {
  const options = daytonaOptions(key, config, onStart);
  return (config.createSandbox ?? defaultCreateSandbox)(options);
}

/**
 * Makes `sandbox` refuse to find or create a Daytona sandbox once `refused()` holds (the site
 * was deleted), so a call already in flight whose sandbox vanished can't recreate it. Wraps
 * Mastra's `find` and `create` acquisition steps, which every start goes through.
 */
function refuseCreateWhen(sandbox: DaytonaSandbox, refused: () => boolean): DaytonaSandbox {
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

/** Looks the site's sandbox up by name without starting it, and deletes it if it exists. */
async function destroyDetached(key: string, config: DaytonaSandboxConfig): Promise<void> {
  const sandbox = await buildSandbox(key, config, async () => {});
  await sandbox.destroy();
}

class DaytonaSiteRuntime implements SiteRuntime {
  readonly id: string;
  readonly previewHosts: readonly string[];
  readonly key: string;
  private readonly config: DaytonaSandboxConfig;
  private readonly onStop: () => void;
  /** Set for the view handed to `onCreate`: it runs while seeding, so it skips the seed gate. */
  private readonly pinned: DaytonaSandbox | null;
  private sandbox: Promise<DaytonaSandbox> | null = null;
  /** Set while the start hook seeds the sandbox; every other call waits for it. */
  private seeding: Promise<void> | null = null;
  private installing: Promise<CommandResult> | null = null;
  private previewStart: Promise<{ url: string }> | null = null;
  /** Set when the site was deleted: this runtime never starts or recreates a sandbox again. */
  private destroyed = false;

  constructor(
    key: string,
    config: DaytonaSandboxConfig,
    onStop: () => void,
    pinned: DaytonaSandbox | null = null,
  ) {
    this.key = key;
    this.config = config;
    this.onStop = onStop;
    this.pinned = pinned;
    this.id = sandboxName(key, config.namePrefix ?? DEFAULTS.namePrefix);
    this.previewHosts = config.previewHosts ?? DAYTONA_PREVIEW_HOSTS;
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

  async ready(): Promise<void> {
    await this.ensure();
  }

  /** The Mastra sandbox, started and seeded. */
  private async ensure(): Promise<DaytonaSandbox> {
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
    return sandbox;
  }

  /**
   * Mastra's start hook: on every start, make the project root and seed it if never done. A
   * start after the site was deleted (a restart under a call already in flight) deletes whatever
   * it reached and fails, so a deleted client's files are never seeded anywhere again.
   */
  private onStart({ sandbox }: { sandbox: unknown; outcome?: "created" | "connected" }) {
    if (this.destroyed) {
      return (sandbox as DaytonaSandbox)
        .destroy()
        .catch(() => {})
        .then(() => {
          throw new Error("This site was deleted.");
        });
    }
    const seeding = this.seed(sandbox as DaytonaSandbox);
    this.seeding = seeding;
    return seeding.finally(() => {
      if (this.seeding === seeding) this.seeding = null;
    });
  }

  private async seed(sandbox: DaytonaSandbox): Promise<void> {
    const marker = posix.join(this.root, SEED_MARKER);
    // The marker's folder too: Daytona's upload isn't documented to make parent folders.
    const folders = `${shellQuote(this.root)} ${shellQuote(posix.dirname(marker))}`;
    const check = await sandbox.executeCommand?.(
      "sh",
      ["-c", `mkdir -p ${folders} && test -f ${shellQuote(marker)}`],
      { cwd: "/", env: commandEnv(COMMAND_ENV), timeout: 60_000 },
    );
    if (!check) throw new Error("This Daytona sandbox can't run commands.");
    if (check.exitCode === 0) return;
    if (check.exitCode !== 1) {
      throw new Error(`Preparing the sandbox failed (exit ${check.exitCode}): ${check.stderr}`);
    }
    const onCreate = this.config.onCreate;
    if (onCreate) {
      await onCreate(this.key, new DaytonaSiteRuntime(this.key, this.config, () => {}, sandbox));
    }
    if (this.destroyed) throw new Error("This site was deleted.");
    await sandbox.writeFiles?.([{ path: marker, content: new Date().toISOString() }]);
  }

  /** Runs `fn` on the started sandbox, once more if the sandbox stopped or died under it. */
  private async use<T>(fn: (sandbox: DaytonaSandbox) => Promise<T>): Promise<T> {
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
    if (!sandbox.executeCommand) throw new Error("This Daytona sandbox can't run commands.");
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
    if (result.timedOut && result.stderr && !stderr.toString()) stderr.push(result.stderr);
    return {
      exitCode: result.exitCode,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      timedOut: result.timedOut === true || result.exitCode === TIMED_OUT_EXIT,
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
    await this.use(async (sandbox) => {
      if (!sandbox.writeFiles) throw new Error("This Daytona sandbox can't write files.");
      await sandbox.writeFiles(checked);
    });
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
    // A pid file kept across a stop can name an unrelated process, so check it is `next`.
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
        if (!sandbox.processes) throw new Error("This Daytona sandbox can't run processes.");
        // In the background, outliving this call: no timeout and no abort signal, and its
        // output goes to the log file (`previewLogs`), so none is held here.
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
    return { url: await this.previewUrl(port) };
  }

  private async previewUrl(port: number): Promise<string> {
    const custom = this.config.previewUrl;
    const ttl = this.config.previewUrlTtlSeconds ?? DEFAULTS.previewUrlTtlSeconds;
    return this.use(async (sandbox) => {
      if (custom) return custom(sandbox, port);
      const signed = await sandbox.daytona.getSignedPreviewUrl(port, ttl);
      return signed.url;
    });
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
    // Daytona keeps a stopped sandbox's files; the next open starts it again.
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
