/**
 * `RuntimeProvider` on Vercel Sandbox (Firecracker microVMs), through `@vercel/sandbox`.
 *
 * Credentials: either an explicit team-scoped access token with its team and project ids, or,
 * when Locus itself runs on Vercel, the deployment's own OIDC token (the SDK fetches it through
 * `@vercel/oidc`), so sandboxes run in the Locus project on Otaku's team with no stored secret.
 *
 * Trust boundary: the credentials are used only here, by the Locus backend, to
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
import { DEFAULT_MAX_OUTPUT_CHARS, TailBuffer, truncateTail } from "./output.ts";
import { validatePath } from "./paths.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export type VercelNodeRuntime = "node22" | "node24" | "node26";

/** An explicit access token, or `oidc` for the Vercel deployment's own OIDC token. */
export type VercelSandboxCredentials =
  | { token: string; teamId: string; projectId: string }
  | { oidc: true };

export type VercelSandboxConfig = VercelSandboxCredentials & VercelSandboxOptions;

export interface VercelSandboxOptions {
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
/** Written under the project root once `onCreate` has completed for a sandbox. */
const SEED_MARKER = ".locus/seeded";
const TIMEOUT_TOLERANCE_MS = 250;

/**
 * Reads `LOCUS_SANDBOX_TOKEN`, `LOCUS_SANDBOX_TEAM_ID` and `LOCUS_SANDBOX_PROJECT_ID` and uses
 * them when all three are set. Otherwise, on a Vercel deployment (`VERCEL=1`), uses the
 * deployment's OIDC token, unless `LOCUS_SANDBOX=off`. Returns null when neither applies.
 */
export function sandboxFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: VercelSandboxOptions = {},
): VercelRuntimeProvider | null {
  if (env.LOCUS_SANDBOX === "off") return null;
  const token = env.LOCUS_SANDBOX_TOKEN;
  const teamId = env.LOCUS_SANDBOX_TEAM_ID;
  const projectId = env.LOCUS_SANDBOX_PROJECT_ID;
  if (token && teamId && projectId) {
    return new VercelRuntimeProvider({ ...overrides, token, teamId, projectId });
  }
  if (env.VERCEL === "1") return new VercelRuntimeProvider({ ...overrides, oidc: true });
  return null;
}

/** Deterministic sandbox name for a site key: safe characters, and the key itself not exposed. */
export function sandboxName(key: string, prefix: string = DEFAULTS.namePrefix): string {
  return `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export class VercelRuntimeProvider implements RuntimeProvider {
  private readonly config: VercelSandboxConfig;
  private readonly runtimes = new Map<string, VercelSiteRuntime>();

  constructor(config: VercelSandboxConfig) {
    if (!("oidc" in config) && (!config.token || !config.teamId || !config.projectId)) {
      throw new Error("VercelRuntimeProvider needs token, teamId and projectId, or oidc");
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

  /** Deletes the site's sandbox and the snapshots only it used. A sandbox that's gone is fine. */
  async destroy(key: string): Promise<void> {
    if (!key) throw new Error("destroy() needs a site key");
    const open = this.runtimes.get(key);
    this.runtimes.delete(key);
    await open?.stop().catch(() => {
      // Deleting below ends it anyway.
    });
    const { Sandbox } = await import("@vercel/sandbox");
    try {
      const sandbox = await Sandbox.get({
        name: sandboxName(key, this.config.namePrefix),
        ...vercelCredentials(this.config),
      });
      await sandbox.delete({ deleteOrphanSnapshots: true });
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
}

/** The SDK's credentials argument. With OIDC none are passed: the SDK reads the token itself. */
function vercelCredentials(config: VercelSandboxConfig) {
  return "oidc" in config
    ? {}
    : { token: config.token, teamId: config.teamId, projectId: config.projectId };
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
  /** Set for the view handed to `onCreate`: it always uses this sandbox and never reopens. */
  private readonly pinned: Sandbox | null;
  /** Only set once the sandbox is open and seeded. */
  private sandbox: Sandbox | null = null;
  private opening: Promise<Sandbox> | null = null;
  private previewStart: Promise<{ url: string }> | null = null;

  constructor(
    key: string,
    config: VercelSandboxConfig,
    onStop: () => void,
    pinned: Sandbox | null = null,
  ) {
    this.key = key;
    this.config = config;
    this.onStop = onStop;
    this.pinned = pinned;
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
  private get seedMarker(): string {
    return posix.join(this.root, SEED_MARKER);
  }

  async ready(): Promise<void> {
    await this.ensure();
  }

  private ensure(): Promise<Sandbox> {
    if (this.pinned) return Promise.resolve(this.pinned);
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
    const credentials = vercelCredentials(this.config);
    let created = false;
    const image =
      this.config.image ??
      `vercel/sandbox/node:${(this.config.runtime ?? DEFAULTS.runtime).slice(4)}`;
    const sandbox = await Sandbox.getOrCreate({
      name: this.id,
      ...credentials,
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
    if (created) {
      await sandbox.mkDir(this.root).catch(() => {
        // The default root already exists; a custom one may not.
      });
    }
    await this.seed(sandbox, created);
    // Published only now, so nobody gets an unseeded sandbox through ensure().
    this.sandbox = sandbox;
    return sandbox;
  }

  /**
   * Runs `onCreate` until it has once completed for this sandbox: a marker file is written when
   * it succeeds, so a seeding that failed or was interrupted runs again on the next open.
   */
  private async seed(sandbox: Sandbox, created: boolean): Promise<void> {
    const onCreate = this.config.onCreate;
    if (!onCreate) return;
    if (!created) {
      const check = await sandbox.runCommand({
        cmd: "test",
        args: ["-f", this.seedMarker],
        env: COMMAND_ENV,
      });
      if (check.exitCode === 0) return;
    }
    await onCreate(this.key, new VercelSiteRuntime(this.key, this.config, () => {}, sandbox));
    await sandbox.writeFiles([{ path: this.seedMarker, content: new Date().toISOString() }]);
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
      if (this.pinned || !isGone(error)) throw error;
      if (this.sandbox === sandbox) this.sandbox = null;
      return fn(await this.ensure());
    }
  }

  /**
   * Runs a command and streams its output into bounded tails (the SDK's own `stdout()` would
   * hold all of it in memory).
   */
  private async exec(
    command: string,
    args: string[],
    timeoutMs: number,
    env: Record<string, string> = COMMAND_ENV,
  ): Promise<CommandResult> {
    return this.use(async (sandbox) => {
      const started = Date.now();
      const running = await sandbox.runCommand({
        cmd: command,
        args,
        cwd: this.root,
        env,
        timeoutMs,
        detached: true,
      });
      const stdout = new TailBuffer(this.maxOutput);
      const stderr = new TailBuffer(this.maxOutput);
      const drain = async () => {
        for await (const line of running.logs()) {
          (line.stream === "stdout" ? stdout : stderr).push(line.data);
        }
      };
      const [, finished] = await Promise.all([drain(), running.wait()]);
      const duration = finished.durationMs ?? Date.now() - started;
      // The sandbox SIGKILLs a command at its timeout: 137 = 128 + 9.
      const killed = finished.exitCode === 137 || finished.exitCode < 0;
      return {
        exitCode: finished.exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut: killed && duration >= timeoutMs - TIMEOUT_TOLERANCE_MS,
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

  install(opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
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
      opts.timeoutMs ?? this.config.installTimeoutMs ?? DEFAULTS.installTimeoutMs,
      { ...COMMAND_ENV, CI: "1" },
    );
  }

  private async previewRunning(): Promise<boolean> {
    // A pid file restored from a snapshot can name an unrelated process, so check it is `next`.
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
    // An open in flight would otherwise publish a sandbox nobody stops.
    const sandbox = this.sandbox ?? (await this.opening?.catch(() => null)) ?? null;
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
