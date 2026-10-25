/**
 * One log line per sandbox step (open, install, preview start, stop, delete) and per failure,
 * so a preview run can be confirmed from the server's logs. Lines carry the site's key, the
 * sandbox id, how long the step took and the exit code; never a command's arguments, its output
 * or the preview URL, which may carry a signed token.
 */

import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export interface SandboxLog {
  info(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

const CONSOLE_LOG: SandboxLog = {
  info: (message, fields) => console.info(message, fields),
  error: (message, fields) => console.error(message, fields),
};

/** A failure's kind and message, never its stack or a cause that may hold a response body. */
function why(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

async function timed<T>(
  log: SandboxLog,
  step: string,
  fields: Record<string, unknown>,
  work: () => Promise<T>,
  done: (value: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const started = Date.now();
  try {
    const value = await work();
    log.info(`sandbox ${step}`, { ...fields, ms: Date.now() - started, ...done(value) });
    return value;
  } catch (error) {
    log.error(`sandbox ${step} failed`, { ...fields, ms: Date.now() - started, error: why(error) });
    throw error;
  }
}

const exit = (result: CommandResult) => ({
  exitCode: result.exitCode,
  ...(result.timedOut ? { timedOut: true } : {}),
});

class LoggedRuntime implements SiteRuntime {
  readonly #inner: SiteRuntime;
  readonly #log: SandboxLog;
  readonly #fields: Record<string, unknown>;
  readonly previewHosts?: readonly string[];

  constructor(inner: SiteRuntime, key: string, log: SandboxLog) {
    this.#inner = inner;
    if (inner.previewHosts) this.previewHosts = inner.previewHosts;
    this.#log = log;
    this.#fields = { key, sandbox: inner.id };
  }

  get id() {
    return this.#inner.id;
  }

  writeFiles(files: RuntimeFile[]) {
    return this.#quiet("write files", () => this.#inner.writeFiles(files), { files: files.length });
  }

  deleteFiles(paths: string[]) {
    return this.#quiet("delete files", () => this.#inner.deleteFiles(paths), {
      files: paths.length,
    });
  }

  async run(command: string, args?: string[], opts?: { timeoutMs?: number }) {
    // Commands are frequent: only a failing one gets a line, by program name alone.
    const result = await this.#quiet("command", () => this.#inner.run(command, args, opts), {
      command,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      this.#log.error("sandbox command failed", { ...this.#fields, command, ...exit(result) });
    }
    return result;
  }

  async install(opts?: { timeoutMs?: number }) {
    const result = await timed(
      this.#log,
      "install",
      this.#fields,
      () => this.#inner.install(opts),
      exit,
    );
    if (result.exitCode !== 0 || result.timedOut) {
      this.#log.error("sandbox install failed", { ...this.#fields, ...exit(result) });
    }
    return result;
  }

  startPreview() {
    return timed(this.#log, "preview start", this.#fields, () => this.#inner.startPreview());
  }

  previewLogs() {
    return this.#quiet("preview logs", () => this.#inner.previewLogs());
  }

  stop() {
    return timed(this.#log, "stop", this.#fields, () => this.#inner.stop());
  }

  /** A frequent step: logged only when it throws. */
  async #quiet<T>(step: string, work: () => Promise<T>, fields: Record<string, unknown> = {}) {
    try {
      return await work();
    } catch (error) {
      this.#log.error(`sandbox ${step} failed`, { ...this.#fields, ...fields, error: why(error) });
      throw error;
    }
  }
}

/** `provider`, logging each sandbox step to `log` (the console unless given). */
export class LoggedRuntimeProvider implements RuntimeProvider {
  readonly inner: RuntimeProvider;
  readonly #log: SandboxLog;
  readonly destroy?: (key: string) => Promise<void>;

  constructor(inner: RuntimeProvider, log: SandboxLog = CONSOLE_LOG) {
    this.inner = inner;
    this.#log = log;
    if (inner.destroy) {
      const destroy = inner.destroy.bind(inner);
      this.destroy = (key) => timed(this.#log, "delete", { key }, () => destroy(key));
    }
  }

  async open(key: string): Promise<SiteRuntime> {
    const runtime = await timed(
      this.#log,
      "open",
      { key },
      () => this.inner.open(key),
      (opened) => ({ sandbox: opened.id }),
    );
    return new LoggedRuntime(runtime, key, this.#log);
  }
}
