/**
 * `RuntimeProvider` on Vercel Sandbox (Firecracker microVMs), through `@vercel/sandbox`.
 *
 * Trust boundary: the token, team and project ids are used only here, by the Locus backend, to
 * create and drive the sandbox through Vercel's API. They are never put in the sandbox's or a
 * command's environment, never written to its filesystem and never passed as arguments.
 *
 * Each site gets one named, persistent sandbox (`locus-site-<hash of key>`). A stopped sandbox
 * resumes with its filesystem on the next call (the SDK does this); one that no longer exists is
 * recreated empty, and `onCreate` lets the caller seed it again.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { DEFAULT_MAX_OUTPUT_CHARS, truncateTail } from "./output.ts";
import { validatePath } from "./paths.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export type VercelNodeRuntime = "node22" | "node24" | "node26";

export interface VercelSandboxConfig {
  /** A Vercel access token scoped to `teamId`. Used by the backend only. */
  token: string;
  teamId: string;
  projectId: string;
  /** Node.js version of the sandbox image (`vercel/sandbox/node:<n>`). Default `node22`. */
  runtime?: VercelNodeRuntime;
  /** Overrides `runtime` with any Vercel Container Registry image. */
  image?: string;
  /** Idle lifetime of a sandbox session; extended while the runtime is in use. Default 30 min. */
  timeoutMs?: number;
  /** Ports to expose. The first one is the preview port. Default `[3000]`. */
  ports?: number[];
  vcpus?: number;
  /** Keep the filesystem between sessions (default true). */
  persistent?: boolean;
  /** Absolute project root inside the sandbox. Default `/vercel/sandbox`. */
  projectRoot?: string;
  /** Default timeout for `run`. Default 5 min. */
  commandTimeoutMs?: number;
  /** Timeout for `install`. Default 10 min. */
  installTimeoutMs?: number;
  /** How long `startPreview` waits for the dev server to answer. Default 90 s; 0 to not wait. */
  previewReadyTimeoutMs?: number;
  /** Bound on each of stdout, stderr and the preview log. Default 64k characters. */
  maxOutputChars?: number;
  /** Prefix of sandbox names. Default `locus-site-`. */
  namePrefix?: string;
  /**
   * Called after a site's sandbox was created empty (first open, or after the old one was
   * deleted or lost its snapshot), before the call that triggered it continues.
   */
  onCreate?: (key: string, runtime: SiteRuntime) => Promise<void>;
}

const DEFAULTS = {
  runtime: "node22" as VercelNodeRuntime,
  timeoutMs: 30 * 60_000,
  ports: [3000],
  persistent: true,
  projectRoot: "/vercel/sandbox",
  commandTimeoutMs: 5 * 60_000,
  installTimeoutMs: 10 * 60_000,
  previewReadyTimeoutMs: 90_000,
  namePrefix: "locus-site-",
};

/** The only environment commands get. Never add credentials here. */
const COMMAND_ENV: Record<string, string> = { NEXT_TELEMETRY_DISABLED: "1" };

const PREVIEW_PID = "/tmp/locus-preview.pid";
const PREVIEW_LOG = "/tmp/locus-preview.log";
const INSTALL_STAMP = "node_modules/.locus-install-stamp";

/**
 * Reads `LOCUS_SANDBOX_TOKEN`, `LOCUS_SANDBOX_TEAM_ID` and `LOCUS_SANDBOX_PROJECT_ID`. Returns
 * null unless all three are set.
 */
export function sandboxFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Omit<VercelSandboxConfig, "token" | "teamId" | "projectId"> = {},
): VercelRuntimeProvider | null {
  const token = env.LOCUS_SANDBOX_TOKEN;
  const teamId = env.LOCUS_SANDBOX_TEAM_ID;
  const projectId = env.LOCUS_SANDBOX_PROJECT_ID;
  if (!token || !teamId || !projectId) return null;
  return new VercelRuntimeProvider({ ...overrides, token, teamId, projectId });
}

/** Deterministic sandbox name for a site key: safe characters, and the key itself not exposed. */
export function sandboxName(key: string, prefix: string = DEFAULTS.namePrefix): string {
  return `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export class VercelRuntimeProvider implements RuntimeProvider {
  private readonly config: VercelSandboxConfig;
  private readonly runtimes = new Map<string, VercelSiteRuntime>();

  constructor(config: VercelSandboxConfig) {
    if (!config.token || !config.teamId || !config.projectId) {
      throw new Error("VercelRuntimeProvider needs token, teamId and projectId");
    }
    const ports = config.ports ?? DEFAULTS.ports;
    if (ports.length === 0) throw new Error("VercelRuntimeProvider needs at least one port");
    this.config = config;
  }

  async open(key: string): Promise<SiteRuntime> {
    if (!key) throw new Error("open() needs a site key");
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = new VercelSiteRuntime(key, this.config, () => {
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
}

/** The SDK's APIError, duck-typed so this module never loads the SDK eagerly. */
function apiStatus(error: unknown): { status?: number; code?: string } {
  const e = error as { response?: { status?: unknown }; json?: { error?: { code?: unknown } } };
  const status = typeof e?.response?.status === "number" ? e.response.status : undefined;
  const code = typeof e?.json?.error?.code === "string" ? e.json.error.code : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  };
}

/** The sandbox is gone for good: deleted, or its snapshot expired. */
function isGone(error: unknown): boolean {
  const { status, code } = apiStatus(error);
  return status === 404 || (status === 410 && code === "snapshot_not_found");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

class VercelSiteRuntime implements SiteRuntime {
  readonly id: string;
  readonly key: string;
  private readonly config: VercelSandboxConfig;
  private readonly onStop: () => void;
  private sandbox: Sandbox | null = null;
  private opening: Promise<Sandbox> | null = null;

  constructor(key: string, config: VercelSandboxConfig, onStop: () => void) {
    this.key = key;
    this.config = config;
    this.onStop = onStop;
    this.id = sandboxName(key, config.namePrefix);
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULTS.timeoutMs;
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

  private ensure(): Promise<Sandbox> {
    if (this.sandbox) return Promise.resolve(this.sandbox);
    if (!this.opening) {
      this.opening = this.connect().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async connect(): Promise<Sandbox> {
    const { Sandbox } = await import("@vercel/sandbox");
    const { token, teamId, projectId } = this.config;
    let created = false;
    const image =
      this.config.image ??
      `vercel/sandbox/node:${(this.config.runtime ?? DEFAULTS.runtime).slice(4)}`;
    const sandbox = await Sandbox.getOrCreate({
      name: this.id,
      token,
      teamId,
      projectId,
      image,
      ports: this.config.ports ?? DEFAULTS.ports,
      timeout: this.timeoutMs,
      persistent: this.config.persistent ?? DEFAULTS.persistent,
      ...(this.config.vcpus === undefined ? {} : { resources: { vcpus: this.config.vcpus } }),
      tags: { app: "locus" },
      onCreate: async () => {
        created = true;
      },
    });
    this.sandbox = sandbox;
    if (created) {
      await sandbox.mkDir(this.root).catch(() => {
        // The default root already exists; a custom one may not.
      });
      await this.config.onCreate?.(this.key, this);
    }
    return sandbox;
  }

  /** Keeps a running session alive while it is used. Best effort: never fails the call. */
  private async touch(sandbox: Sandbox): Promise<void> {
    const expiresAt = sandbox.expiresAt?.getTime();
    if (expiresAt === undefined) return;
    const remaining = expiresAt - Date.now();
    // Already expired: the next call resumes a fresh session with the full timeout.
    if (remaining <= 0 || remaining >= this.timeoutMs / 2) return;
    try {
      await sandbox.extendTimeout(this.timeoutMs - remaining);
    } catch {
      // The plan's maximum duration may be reached; the sandbox then stops and resumes later.
    }
  }

  /** Runs `fn` on the sandbox; if the sandbox no longer exists, recreates it and retries once. */
  private async use<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await this.ensure();
    await this.touch(sandbox);
    try {
      return await fn(sandbox);
    } catch (error) {
      if (!isGone(error)) throw error;
      if (this.sandbox === sandbox) this.sandbox = null;
      return fn(await this.ensure());
    }
  }

  private async exec(
    command: string,
    args: string[],
    timeoutMs: number,
    env: Record<string, string> = COMMAND_ENV,
  ): Promise<CommandResult> {
    return this.use(async (sandbox) => {
      const started = Date.now();
      const finished = await sandbox.runCommand({
        cmd: command,
        args,
        cwd: this.root,
        env,
        timeoutMs,
      });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      const elapsed = Date.now() - started;
      const timedOut = elapsed >= timeoutMs && finished.exitCode !== 0;
      return {
        exitCode: finished.exitCode,
        stdout: truncateTail(stdout, this.maxOutput),
        stderr: truncateTail(stderr, this.maxOutput),
        timedOut,
      };
    });
  }

  async writeFiles(files: RuntimeFile[]): Promise<void> {
    if (files.length === 0) return;
    const checked = files.map((file) => ({
      path: posix.join(this.root, validatePath(file.path)),
      content: file.content,
    }));
    await this.use((sandbox) => sandbox.writeFiles(checked));
  }

  async deleteFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const checked = paths.map(validatePath);
    const result = await this.exec("rm", ["-rf", "--", ...checked], DEFAULTS.commandTimeoutMs);
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

  install(): Promise<CommandResult> {
    const digest = `{ cat package.json; cat pnpm-lock.yaml 2>/dev/null; cat package-lock.json 2>/dev/null; } | sha256sum | cut -d' ' -f1`;
    const script = [
      `[ -f package.json ] || { echo "package.json not found" >&2; exit 1; }`,
      `sum=$(${digest})`,
      `if [ -f ${INSTALL_STAMP} ] && [ "$(cat ${INSTALL_STAMP})" = "$sum" ]; then echo "dependencies up to date"; exit 0; fi`,
      `if [ -f package-lock.json ] && [ ! -f pnpm-lock.yaml ]; then npm install; else pnpm install; fi`,
      `code=$?`,
      `if [ "$code" -eq 0 ]; then mkdir -p node_modules && ${digest} > ${INSTALL_STAMP}; fi`,
      `exit "$code"`,
    ].join("\n");
    return this.exec(
      "sh",
      ["-c", script],
      this.config.installTimeoutMs ?? DEFAULTS.installTimeoutMs,
      { ...COMMAND_ENV, CI: "1" },
    );
  }

  private async previewRunning(): Promise<boolean> {
    // A pid file restored from a snapshot can name an unrelated process, so check it is `next`.
    const script = `pid=$(cat ${PREVIEW_PID} 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q next "/proc/$pid/cmdline" 2>/dev/null`;
    const result = await this.exec("sh", ["-c", script], 30_000);
    return result.exitCode === 0;
  }

  async startPreview(): Promise<{ url: string }> {
    const port = this.previewPort;
    if (!(await this.previewRunning())) {
      const script = `echo $$ > ${PREVIEW_PID}; exec ./node_modules/.bin/next dev --port ${port} --hostname 0.0.0.0 > ${PREVIEW_LOG} 2>&1`;
      await this.use((sandbox) =>
        sandbox.runCommand({
          cmd: "sh",
          args: ["-c", script],
          cwd: this.root,
          env: COMMAND_ENV,
          detached: true,
        }),
      );
      await this.waitForPreview(port);
    }
    const sandbox = await this.ensure();
    return { url: sandbox.domain(port) };
  }

  /** Waits until the dev server answers or dies. Not being ready is not an error: read the logs. */
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
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (!sandbox) return;
    try {
      await sandbox.stop();
    } catch (error) {
      // Already stopped, or gone: either way it is not running.
      const { status } = apiStatus(error);
      if (status !== undefined && status !== 404 && status !== 410) throw error;
    }
  }
}
