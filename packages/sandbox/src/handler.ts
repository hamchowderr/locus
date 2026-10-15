/**
 * The web app's side of the sandbox RPC: a framework-free `Request -> Response` handler. It
 * authenticates the bearer token, reads a bounded body, lets the host turn (principal, site id)
 * into a sandbox key, then drives `provider.open(key)` and one `SiteRuntime` method.
 *
 * Trust: the host's `authenticate` verifies the token (who) and `sandboxKey` runs the access
 * checks (may they, on this site). The body never names a client or a sandbox key. Anything
 * unauthenticated, or not a POST, gets the same bare 404, before its body is read. Bodies are
 * never logged. Nothing goes back but what a local `SiteRuntime` returns, and never its id.
 */
import { InvalidPathError } from "./paths.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  SANDBOX_OPS,
  type SandboxOp,
  type SandboxRpcResponse,
  type WireError,
} from "./rpc.ts";
import type { RuntimeFile, RuntimeProvider, SiteRuntime } from "./runtime.ts";

export interface SandboxHandlerOptions<P> {
  provider: RuntimeProvider;
  /** Verifies the bearer token; null (or a throw) is answered 404. */
  authenticate: (token: string) => P | null | Promise<P | null>;
  /**
   * The sandbox key for `siteId`, after checking this principal may work on it now; null is
   * answered 403, the same whether the site is missing, another client's, or the member lost
   * access. A throw is answered 500 with no detail.
   */
  sandboxKey: (principal: P, siteId: string) => string | null | Promise<string | null>;
  /** Default `DEFAULT_MAX_BODY_BYTES` (4 MiB). */
  maxBodyBytes?: number;
}

const MAX_SITE_ID_LENGTH = 256;
const MAX_FILES = 5_000;
const MAX_ARGS = 1_000;

const notFound = () => new Response("Not Found", { status: 404, headers: noStore });
const noStore = { "cache-control": "no-store" };
const forbidden = () =>
  Response.json(
    { ok: false, error: { name: "Forbidden", message: "You don't have access to this site." } },
    { status: 403, headers: noStore },
  );
const json = (body: SandboxRpcResponse, status = 200) =>
  Response.json(body, { status, headers: noStore });

/** A request the handler refuses before it reaches the runtime. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/** Reads at most `max` bytes of the body; null when it is larger. */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringArray(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string")) {
    throw new BadRequest(`${what} must be an array of at most ${max} strings`);
  }
  return value as string[];
}

function files(value: unknown): RuntimeFile[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    throw new BadRequest(`files must be an array of at most ${MAX_FILES} files`);
  }
  return value.map((file) => {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new BadRequest("each file needs a path");
    }
    if (typeof file.content === "string" && file.base64 === undefined) {
      return { path: file.path, content: file.content };
    }
    if (typeof file.base64 === "string" && file.content === undefined) {
      return { path: file.path, content: new Uint8Array(Buffer.from(file.base64, "base64")) };
    }
    throw new BadRequest("each file needs either content or base64");
  });
}

type Call = (runtime: SiteRuntime) => Promise<unknown>;

/** Checks the args (throwing `BadRequest`) before any runtime is opened, and returns the call. */
function prepare(op: SandboxOp, args: Record<string, unknown>): Call {
  switch (op) {
    case "open":
      // Opening is the call; the runtime's id (a sandbox name) stays here.
      return async () => ({});
    case "writeFiles": {
      const checked = files(args.files);
      return async (runtime) => {
        await runtime.writeFiles(checked);
        return null;
      };
    }
    case "deleteFiles": {
      const paths = stringArray(args.paths, "paths", MAX_FILES);
      return async (runtime) => {
        await runtime.deleteFiles(paths);
        return null;
      };
    }
    case "run": {
      if (typeof args.command !== "string" || !args.command) {
        throw new BadRequest("run needs a command");
      }
      const runArgs = args.args === undefined ? [] : stringArray(args.args, "args", MAX_ARGS);
      const timeoutMs = args.timeoutMs;
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      ) {
        throw new BadRequest("timeoutMs must be a positive number");
      }
      const command = args.command;
      const opts = timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number };
      return (runtime) => runtime.run(command, runArgs, opts);
    }
    case "install":
      return (runtime) => runtime.install();
    case "startPreview":
      return (runtime) => runtime.startPreview();
    case "previewLogs":
      return (runtime) => runtime.previewLogs();
    case "stop":
      return async (runtime) => {
        await runtime.stop();
        return null;
      };
  }
}

/** An error as the caller sees it: name and message, never the stack. */
function toWire(error: unknown): WireError {
  if (error instanceof InvalidPathError) {
    return { name: error.name, message: error.message, path: error.path };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: "The sandbox call failed." };
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] ?? null;
}

/**
 * Handles one sandbox call. Responses: 404 (no valid token, or not a POST), 413 (body over the
 * cap), 400 (not JSON, unknown op or bad args), 403 (`sandboxKey` refused), 200 with
 * `{ ok: true, result }` or, when the runtime threw, `{ ok: false, error: { name, message } }`.
 */
export async function handleSandboxRequest<P>(
  request: Request,
  options: SandboxHandlerOptions<P>,
): Promise<Response> {
  if (request.method !== "POST") return notFound();
  const token = bearer(request);
  if (!token) return notFound();
  let principal: P | null;
  try {
    principal = await options.authenticate(token);
  } catch {
    principal = null;
  }
  if (principal === null || principal === undefined) return notFound();

  const body = await readBounded(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (body === null) {
    return json({ ok: false, error: { name: "BadRequest", message: "body too large" } }, 413);
  }

  let siteId: string;
  let call: Call;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) throw new BadRequest("body must be an object");
    if (
      typeof parsed.siteId !== "string" ||
      !parsed.siteId ||
      parsed.siteId.length > MAX_SITE_ID_LENGTH
    ) {
      throw new BadRequest("siteId must be a non-empty string");
    }
    if (typeof parsed.op !== "string" || !(SANDBOX_OPS as readonly string[]).includes(parsed.op)) {
      throw new BadRequest("unknown operation");
    }
    if (parsed.args !== undefined && !isRecord(parsed.args)) {
      throw new BadRequest("args must be an object");
    }
    siteId = parsed.siteId;
    call = prepare(parsed.op as SandboxOp, (parsed.args as Record<string, unknown>) ?? {});
  } catch (error) {
    const message = error instanceof BadRequest ? error.message : "body must be JSON";
    return json({ ok: false, error: { name: "BadRequest", message } }, 400);
  }

  let key: string | null;
  try {
    key = await options.sandboxKey(principal, siteId);
  } catch {
    // Not a refusal (those are null): an outage. Nothing about it goes back.
    return json({ ok: false, error: { name: "Error", message: "The sandbox call failed." } }, 500);
  }
  if (!key) return forbidden();

  try {
    const result = await call(await options.provider.open(key));
    return json({ ok: true, result: result ?? null });
  } catch (error) {
    return json({ ok: false, error: toWire(error) });
  }
}
