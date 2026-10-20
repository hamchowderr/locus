/**
 * The runtime a site-building agent works in: an isolated machine holding one site's Next.js
 * project. Everything that runs here is untrusted (generated code, its dependencies, their
 * install scripts), so no Locus or agency credential is ever passed into it.
 */

export interface RuntimeFile {
  /** Relative to the project root. No "..", no absolute paths, no NUL. */
  path: string;
  content: string | Uint8Array;
}

export interface CommandResult {
  exitCode: number;
  /** The tail of stdout, bounded in size. */
  stdout: string;
  /** The tail of stderr, bounded in size. */
  stderr: string;
  timedOut: boolean;
}

export interface SiteRuntime {
  readonly id: string;
  /** Writes files (paths relative to the project root, no "..", no absolute paths). */
  writeFiles(files: RuntimeFile[]): Promise<void>;
  deleteFiles(paths: string[]): Promise<void>;
  /** Runs one command in the project root. Output is truncated to a bounded size (keep the tail). */
  run(command: string, args?: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
  /** Installs dependencies (pnpm/npm per lockfile) if package.json changed since the last install. */
  install(opts?: { timeoutMs?: number }): Promise<CommandResult>;
  /** Starts `next dev` on a fixed port if it isn't running; returns the public preview URL. */
  startPreview(): Promise<{ url: string }>;
  /** The dev server's recent output (tail), for the agent to read runtime/compile errors. */
  previewLogs(): Promise<string>;
  stop(): Promise<void>;
}

export interface RuntimeProvider {
  /** Opens (or reuses, if still alive) the runtime for one site. `key` identifies the site. */
  open(key: string): Promise<SiteRuntime>;
  /**
   * Deletes the site's runtime and its files for good, when the site is deleted. Nothing
   * happens if it doesn't exist. A provider that can't do this leaves it out.
   */
  destroy?(key: string): Promise<void>;
}
