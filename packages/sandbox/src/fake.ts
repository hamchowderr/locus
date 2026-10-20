/**
 * An in-memory `RuntimeProvider` for tests in other packages. No network, no `@vercel/sandbox`.
 */
import { DEFAULT_MAX_OUTPUT_CHARS, truncateTail } from "./output.ts";
import { validatePath } from "./paths.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export type FakeFiles = ReadonlyMap<string, string | Uint8Array>;

/**
 * Decides what a command "does". Return any part of a `CommandResult`; missing fields default to
 * exit 0, empty output, not timed out. `install()` calls it as `("pnpm" | "npm", ["install"])`.
 */
export type FakeCommandHandler = (
  command: string,
  args: string[],
  files: FakeFiles,
) => Partial<CommandResult> | undefined | Promise<Partial<CommandResult> | undefined>;

export type FakeCall =
  | { method: "writeFiles"; paths: string[] }
  | { method: "deleteFiles"; paths: string[] }
  | { method: "run"; command: string; args: string[]; timeoutMs?: number }
  | { method: "install"; skipped: boolean }
  | { method: "startPreview"; alreadyRunning: boolean }
  | { method: "previewLogs" }
  | { method: "stop" };

export interface FakeRuntimeOptions {
  handler?: FakeCommandHandler;
  /** Defaults to `https://preview.fake`; the URL is `<base>/<key>`. */
  previewBaseUrl?: string;
  /** Initial files, by project-relative path. */
  files?: Record<string, string | Uint8Array>;
  maxOutputChars?: number;
}

export class FakeRuntime implements SiteRuntime {
  readonly id: string;
  readonly key: string;
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: FakeCall[] = [];
  handler: FakeCommandHandler | undefined;
  previewUrl: string;
  previewRunning = false;
  stopped = false;
  private logs = "";
  /** package.json and lockfiles as of the last successful install. */
  private installedManifest: string | null = null;
  private readonly maxOutputChars: number;

  constructor(key: string, options: FakeRuntimeOptions = {}) {
    this.key = key;
    this.id = `fake-${key}`;
    this.handler = options.handler;
    this.previewUrl = `${options.previewBaseUrl ?? "https://preview.fake"}/${key}`;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(validatePath(path), content);
    }
  }

  /** Sets what `previewLogs()` returns. */
  setPreviewLogs(logs: string): void {
    this.logs = logs;
  }

  /** A file's content as text, or undefined. */
  readText(path: string): string | undefined {
    const content = this.files.get(validatePath(path));
    if (content === undefined) return undefined;
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  }

  async writeFiles(files: RuntimeFile[]): Promise<void> {
    const checked = files.map((file) => ({ path: validatePath(file.path), content: file.content }));
    this.calls.push({ method: "writeFiles", paths: checked.map((file) => file.path) });
    for (const file of checked) this.files.set(file.path, file.content);
  }

  async deleteFiles(paths: string[]): Promise<void> {
    const checked = paths.map(validatePath);
    this.calls.push({ method: "deleteFiles", paths: checked });
    for (const path of checked) {
      for (const existing of [...this.files.keys()]) {
        if (existing === path || existing.startsWith(`${path}/`)) this.files.delete(existing);
      }
    }
  }

  async run(
    command: string,
    args: string[] = [],
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    this.calls.push({
      method: "run",
      command,
      args,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    return this.exec(command, args);
  }

  async install(_opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const packageJson = this.readText("package.json");
    if (packageJson === undefined) {
      this.calls.push({ method: "install", skipped: false });
      return { exitCode: 1, stdout: "", stderr: "package.json not found", timedOut: false };
    }
    if (this.manifest() === this.installedManifest) {
      this.calls.push({ method: "install", skipped: true });
      return { exitCode: 0, stdout: "dependencies up to date", stderr: "", timedOut: false };
    }
    this.calls.push({ method: "install", skipped: false });
    const npm = this.files.has("package-lock.json") && !this.files.has("pnpm-lock.yaml");
    const result = await this.exec(npm ? "npm" : "pnpm", ["install"]);
    // Taken after the install, which may have written the lockfile (as the real stamp is).
    if (result.exitCode === 0) this.installedManifest = this.manifest();
    return result;
  }

  /** What decides whether an install is needed: package.json and the lockfiles. */
  private manifest(): string {
    return JSON.stringify(
      ["package.json", "pnpm-lock.yaml", "package-lock.json"].map((path) => this.readText(path)),
    );
  }

  async startPreview(): Promise<{ url: string }> {
    this.calls.push({ method: "startPreview", alreadyRunning: this.previewRunning });
    this.previewRunning = true;
    return { url: this.previewUrl };
  }

  async previewLogs(): Promise<string> {
    this.calls.push({ method: "previewLogs" });
    return truncateTail(this.logs, this.maxOutputChars);
  }

  async stop(): Promise<void> {
    this.calls.push({ method: "stop" });
    this.previewRunning = false;
    this.stopped = true;
  }

  private async exec(command: string, args: string[]): Promise<CommandResult> {
    const result = (await this.handler?.(command, args, this.files)) ?? {};
    return {
      exitCode: result.exitCode ?? 0,
      stdout: truncateTail(result.stdout ?? "", this.maxOutputChars),
      stderr: truncateTail(result.stderr ?? "", this.maxOutputChars),
      timedOut: result.timedOut ?? false,
    };
  }
}

/**
 * Hands out one `FakeRuntime` per key. Like a persistent sandbox, reopening a stopped runtime
 * gives back the same files (with the preview no longer running).
 */
export class FakeRuntimeProvider implements RuntimeProvider {
  readonly runtimes = new Map<string, FakeRuntime>();
  private readonly options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    this.options = options;
  }

  async open(key: string): Promise<FakeRuntime> {
    const existing = this.runtimes.get(key);
    if (existing) {
      existing.stopped = false;
      return existing;
    }
    const runtime = new FakeRuntime(key, this.options);
    this.runtimes.set(key, runtime);
    return runtime;
  }

  async destroy(key: string): Promise<void> {
    const runtime = this.runtimes.get(key);
    if (runtime) runtime.stopped = true;
    this.runtimes.delete(key);
  }
}
