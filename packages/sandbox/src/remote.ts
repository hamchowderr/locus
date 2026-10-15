/**
 * `RuntimeProvider` that drives sandboxes through another Locus process over HTTP: a backend off
 * Vercel (the agent server on Coolify) calls the web app's `/api/internal/sandbox`, and the web
 * app, which can authenticate to Vercel Sandbox with its deployment's OIDC token, does the work
 * with its own provider (`handleSandboxRequest`).
 *
 * No new credential: each call carries a short-lived token the caller mints for one member and
 * client (`mintAgentToWebToken` in `@locus/auth`, keyed from the `BETTER_AUTH_SECRET` both
 * processes already hold). `open(siteId)` takes a site id, not a sandbox key: the web app checks
 * the site is the token's client's and derives the key itself. No credential reaches the sandbox.
 */
import { InvalidPathError, validatePath } from "./paths.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  SANDBOX_RPC_PATH,
  type SandboxOp,
  type SandboxRpcResponse,
  type WireError,
  type WireFile,
} from "./rpc.ts";
import type { CommandResult, RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export interface RemoteSandboxConfig {
  /** The sandbox endpoint's full URL, e.g. `https://locus.example.com/api/internal/sandbox`. */
  url: string;
  /**
   * A fresh bearer token for the member and client this provider acts for (at most 10 minutes
   * valid), e.g. `mintAgentToWebToken(agentToWebKey(BETTER_AUTH_SECRET), claims)`. Called on
   * every request.
   */
  mintToken: () => string | Promise<string>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** The endpoint's body cap; `writeFiles` is split to stay under it. Default 4 MiB. */
  maxBodyBytes?: number;
}

/**
 * An error the remote runtime threw (its name in `remoteName`, its message unchanged), or a
 * failure to reach the endpoint at all. `InvalidPathError` comes back as itself.
 */
export class RemoteSandboxError extends Error {
  readonly remoteName: string | null;
  readonly status: number | null;

  constructor(message: string, opts: { remoteName?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = "RemoteSandboxError";
    this.remoteName = opts.remoteName ?? null;
    this.status = opts.status ?? null;
  }
}

function fromWire(error: WireError, status: number): Error {
  if (error.name === "InvalidPathError" && typeof error.path === "string") {
    const rebuilt = new InvalidPathError(error.path, "");
    rebuilt.message = error.message;
    return rebuilt;
  }
  return new RemoteSandboxError(error.message, { remoteName: error.name, status });
}

const encodeFile = (file: RuntimeFile): WireFile =>
  typeof file.content === "string"
    ? { path: file.path, content: file.content }
    : { path: file.path, base64: Buffer.from(file.content).toString("base64") };

/** Room left in a body for the envelope around the files. */
const ENVELOPE_BYTES = 4 * 1024;

export class RemoteRuntimeProvider implements RuntimeProvider {
  readonly url: URL;
  private readonly mintToken: () => string | Promise<string>;
  private readonly fetchImpl: typeof fetch;
  readonly maxBodyBytes: number;

  constructor(config: RemoteSandboxConfig) {
    if (!config.url) throw new Error("RemoteRuntimeProvider needs the sandbox endpoint's url");
    if (typeof config.mintToken !== "function") {
      throw new Error("RemoteRuntimeProvider needs mintToken");
    }
    this.url = new URL(config.url);
    this.mintToken = config.mintToken;
    this.fetchImpl = config.fetch ?? fetch;
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /** Opens the runtime of one of the token's client's sites. `siteId` is the site's id. */
  async open(siteId: string): Promise<SiteRuntime> {
    if (!siteId) throw new Error("open() needs a site key");
    await this.call(siteId, "open");
    return new RemoteSiteRuntime(this, siteId);
  }

  /** One call; resolves with the result or throws the runtime's error. */
  async call(siteId: string, op: SandboxOp, args?: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(args === undefined ? { siteId, op } : { siteId, op, args });
    const size = Buffer.byteLength(body);
    if (size > this.maxBodyBytes) {
      throw new RemoteSandboxError(
        `The ${op} call is ${size} bytes, over the sandbox endpoint's ${this.maxBodyBytes}-byte limit.`,
      );
    }
    const token = await this.mintToken();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        cache: "no-store",
      });
    } catch (error) {
      throw new RemoteSandboxError(
        `The sandbox endpoint can't be reached: ${(error as Error)?.message ?? "network error"}`,
      );
    }
    let payload: SandboxRpcResponse | null = null;
    try {
      payload = (await response.json()) as SandboxRpcResponse;
    } catch {
      payload = null;
    }
    if (payload && typeof payload === "object" && "ok" in payload) {
      if (payload.ok) return payload.result;
      if (payload.error && typeof payload.error.message === "string") {
        throw fromWire(payload.error, response.status);
      }
    }
    throw new RemoteSandboxError(
      response.status === 404
        ? "The sandbox endpoint refused the call (404): check LOCUS_SANDBOX_URL, that both sides share BETTER_AUTH_SECRET, the clocks, and that the web app has sandboxes configured."
        : `The sandbox endpoint answered ${response.status}.`,
      { status: response.status },
    );
  }
}

class RemoteSiteRuntime implements SiteRuntime {
  readonly id: string;
  private readonly provider: RemoteRuntimeProvider;
  private readonly key: string;

  constructor(provider: RemoteRuntimeProvider, siteId: string) {
    this.provider = provider;
    this.key = siteId;
    // The real runtime's id (a sandbox name) never leaves the web app.
    this.id = `remote-${siteId}`;
  }

  async writeFiles(files: RuntimeFile[]): Promise<void> {
    // Checked here too, so a bad path fails before any batch is sent.
    const encoded = files.map((file) => encodeFile({ ...file, path: validatePath(file.path) }));
    // Split into batches that fit the endpoint's body cap. Each batch is written in order.
    const budget = this.provider.maxBodyBytes - ENVELOPE_BYTES - Buffer.byteLength(this.key);
    let batch: WireFile[] = [];
    let size = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await this.provider.call(this.key, "writeFiles", { files: batch });
      batch = [];
      size = 0;
    };
    for (const file of encoded) {
      const fileSize = Buffer.byteLength(JSON.stringify(file)) + 1;
      if (size + fileSize > budget) await flush();
      batch.push(file);
      size += fileSize;
    }
    if (batch.length > 0 || encoded.length === 0) {
      await this.provider.call(this.key, "writeFiles", { files: batch });
    }
  }

  async deleteFiles(paths: string[]): Promise<void> {
    await this.provider.call(this.key, "deleteFiles", { paths: paths.map(validatePath) });
  }

  async run(
    command: string,
    args: string[] = [],
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    if (!command) throw new Error("run() needs a command");
    return (await this.provider.call(this.key, "run", {
      command,
      args,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    })) as CommandResult;
  }

  async install(): Promise<CommandResult> {
    return (await this.provider.call(this.key, "install")) as CommandResult;
  }

  async startPreview(): Promise<{ url: string }> {
    return (await this.provider.call(this.key, "startPreview")) as { url: string };
  }

  async previewLogs(): Promise<string> {
    return (await this.provider.call(this.key, "previewLogs")) as string;
  }

  async stop(): Promise<void> {
    await this.provider.call(this.key, "stop");
  }
}

/**
 * A `RemoteRuntimeProvider` for one member and client when `LOCUS_SANDBOX_URL` (the web app's
 * base URL, e.g. `https://locus.example.com`) is set; otherwise null. `mintToken` signs for that
 * member and client (see `RemoteSandboxConfig.mintToken`).
 */
export function remoteSandboxFromEnv(
  env: Record<string, string | undefined>,
  mintToken: () => string | Promise<string>,
): RemoteRuntimeProvider | null {
  const base = env.LOCUS_SANDBOX_URL?.trim();
  if (!base) return null;
  return new RemoteRuntimeProvider({
    url: new URL(SANDBOX_RPC_PATH.slice(1), base.endsWith("/") ? base : `${base}/`).toString(),
    mintToken,
  });
}
