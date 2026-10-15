/**
 * The wire protocol between `RemoteRuntimeProvider` (a Locus backend off Vercel) and
 * `handleSandboxRequest` (the web app on Vercel, which can reach Vercel Sandbox).
 *
 * Every call is one JSON POST, `{ siteId, op, args }`, with `Authorization: Bearer <token>`. The
 * token names the member and client (minted by the caller, verified by the web app); the body
 * never does. The web app turns token + site id into the sandbox key after its own checks.
 */

/** The web app's route, relative to its base URL. */
export const SANDBOX_RPC_PATH = "/api/internal/sandbox";
/** Below Vercel's 4.5 MB request body limit. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export const SANDBOX_OPS = [
  "open",
  "writeFiles",
  "deleteFiles",
  "run",
  "install",
  "startPreview",
  "previewLogs",
  "stop",
] as const;
export type SandboxOp = (typeof SANDBOX_OPS)[number];

/** A file on the wire: text as is, bytes as base64. */
export type WireFile = { path: string; content: string } | { path: string; base64: string };

/** An error the runtime threw, without its stack. `path` is set for an `InvalidPathError`. */
export interface WireError {
  name: string;
  message: string;
  path?: string;
}

export type SandboxRpcResponse = { ok: true; result: unknown } | { ok: false; error: WireError };
