import type { GhlOperation, SessionParam, TokenKind } from "./operation.ts";
import type { GhlRateLimiter } from "./rate-limit.ts";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";

/** Resolved server-side from the session. Never built from request input. */
export interface GhlSession {
  token: string;
  tokenKind: TokenKind;
  /** The client this session acts on. Required for any operation that names a location. */
  locationId?: string;
  /** The agency this session belongs to. */
  companyId?: string;
}

export interface GhlRequestInput {
  path?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: Record<string, unknown> | undefined;
}

export interface GhlRequestOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** The client's shared burst budget; see `rate-limit.ts`. Without one, nothing is throttled. */
  rateLimiter?: GhlRateLimiter | undefined;
}

/** How long GHL asks us to wait after a 429 when it does not say. */
const DEFAULT_RETRY_AFTER_MS = 10_000;

export class GhlError extends Error {
  readonly operationId: string;
  readonly status: number;
  readonly code: string | undefined;

  constructor(operationId: string, status: number, message: string, code?: string) {
    super(`${operationId}: ${status} ${message}`);
    this.name = "GhlError";
    this.operationId = operationId;
    this.status = status;
    this.code = code;
  }
}

/** A request that breaks a Locus rule. Thrown before anything is sent. */
export class GhlUsageError extends Error {
  override name = "GhlUsageError";
}

const PLACEHOLDER = /\{([^}]+)\}/g;

export async function ghlRequest<T = unknown>(
  operation: GhlOperation,
  session: GhlSession,
  input: GhlRequestInput = {},
  options: GhlRequestOptions = {},
): Promise<T> {
  const needsAuth = operation.tokens.length > 0;
  if (needsAuth && !operation.tokens.includes(session.tokenKind)) {
    throw new GhlUsageError(
      `${operation.id} needs a ${operation.tokens.join(" or ")} token, got a ${session.tokenKind} token`,
    );
  }
  if (operation.body === "multipart") {
    throw new GhlUsageError(`${operation.id}: multipart request bodies are not supported yet`);
  }
  rejectCallerSessionParams(operation, input);

  const pathParams = { ...input.path };
  const query = { ...input.query };
  let body = input.body ? { ...input.body } : undefined;

  for (const param of operation.sessionParams ?? []) {
    const value = sessionValue(param, session);
    if (value === undefined) {
      if (param.required) {
        throw new GhlUsageError(`${operation.id} needs ${param.value} but the session names none`);
      }
      continue;
    }
    if (param.in === "path") pathParams[param.name] = value;
    else if (param.in === "query") query[param.name] = value;
    else body = { ...body, [param.name]: value };
  }

  const url = new URL(fillPath(operation, pathParams), options.baseUrl ?? GHL_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Version: operation.version,
    Accept: "application/json",
  };
  if (needsAuth) headers.Authorization = `Bearer ${session.token}`;
  let encoded: string | undefined;
  if (body && operation.body === "form") {
    // OAuth endpoints take application/x-www-form-urlencoded: flat string fields only.
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (typeof value === "object") {
        throw new GhlUsageError(`${operation.id}: form field "${key}" must be a plain value`);
      }
      form.set(key, String(value));
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    encoded = form.toString();
  } else if (body) {
    headers["Content-Type"] = "application/json";
    encoded = JSON.stringify(body);
  }

  const budget = rateLimitKey(session);
  await options.rateLimiter?.acquire(budget);
  const res = await (options.fetch ?? fetch)(url, {
    method: operation.method,
    headers,
    ...(encoded === undefined ? {} : { body: encoded }),
  });
  if (res.status === 429) options.rateLimiter?.pause(budget, retryAfterMs(res));

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    // Never echo the body: it may be anything, including text aimed at the agent.
    throw new GhlError(operation.id, res.status, `response was not JSON (${text.length} bytes)`);
  }
  if (!res.ok) throw toGhlError(operation.id, res.status, payload);
  return payload as T;
}

/**
 * `locationId` is refused everywhere, whatever the operation declares — it is the tenancy
 * boundary, so a caller naming it is a bug even where GHL would ignore it. The operation's other
 * session parameters (`altId`, `companyId`, …) are refused where the operation expects them.
 */
function rejectCallerSessionParams(operation: GhlOperation, input: GhlRequestInput): void {
  const sources = { path: input.path, query: input.query, body: input.body };
  const refused = (where: keyof typeof sources, name: string) =>
    sources[where] !== undefined && Object.hasOwn(sources[where], name);

  for (const where of ["path", "query", "body"] as const) {
    if (refused(where, "locationId")) {
      throw new GhlUsageError(
        `${operation.id}: locationId comes from the session, never from the caller`,
      );
    }
  }
  for (const param of operation.sessionParams ?? []) {
    if (refused(param.in, param.name)) {
      throw new GhlUsageError(
        `${operation.id}: ${param.name} comes from the session, never from the caller`,
      );
    }
  }
}

/** GHL counts requests per location, or per agency for agency tokens. */
export function rateLimitKey(session: GhlSession): string {
  return session.tokenKind === "location"
    ? `location:${session.locationId ?? "none"}`
    : `agency:${session.companyId ?? "none"}`;
}

function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const interval = Number(res.headers.get("x-ratelimit-interval-milliseconds"));
  if (Number.isFinite(interval) && interval > 0) return interval;
  return DEFAULT_RETRY_AFTER_MS;
}

function sessionValue(param: SessionParam, session: GhlSession): string | undefined {
  switch (param.value) {
    case "locationId":
      return session.locationId;
    case "companyId":
      return session.companyId;
    case "altType":
      return "location";
  }
}

function fillPath(operation: GhlOperation, params: Record<string, string>): string {
  const used = new Set<string>();
  const path = operation.path.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new GhlUsageError(`${operation.id} is missing path parameter "${name}"`);
    }
    used.add(name);
    return encodeURIComponent(value);
  });
  const extra = Object.keys(params).filter((name) => !used.has(name));
  if (extra.length > 0) {
    throw new GhlUsageError(`${operation.id} has no path parameter(s): ${extra.join(", ")}`);
  }
  return path;
}

/** GHL errors come as `{statusCode, message}` and, on one OAuth endpoint, AIP-style `{error}`. */
function toGhlError(operationId: string, status: number, payload: unknown): GhlError {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const aip = p.error;
    if (aip && typeof aip === "object" && "message" in aip) {
      const { message, code } = aip as { message: unknown; code?: unknown };
      return new GhlError(
        operationId,
        status,
        String(message),
        code === undefined ? undefined : String(code),
      );
    }
    if (typeof p.message === "string" || Array.isArray(p.message)) {
      return new GhlError(operationId, status, [p.message].flat().join("; "));
    }
  }
  return new GhlError(operationId, status, `HTTP ${status}`);
}
