import type { GhlOperation, TokenKind } from "./operation.ts";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";

/** Resolved server-side from the session. Never built from request input. */
export interface GhlSession {
  token: string;
  tokenKind: TokenKind;
  /** The client this session acts on. Required for any operation that names a location. */
  locationId?: string;
}

export interface GhlRequestInput {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
}

export interface GhlRequestOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class GhlError extends Error {
  constructor(
    readonly operationId: string,
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(`${operationId}: ${status} ${message}`);
    this.name = "GhlError";
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
  if (session.tokenKind !== operation.token) {
    throw new GhlUsageError(
      `${operation.id} needs a ${operation.token} token, got a ${session.tokenKind} token`,
    );
  }
  rejectCallerLocationId(operation, input);

  const pathParams = { ...input.path };
  const query = { ...input.query };
  const body = input.body ? { ...input.body } : undefined;

  if (operation.location) {
    if (!session.locationId) {
      throw new GhlUsageError(`${operation.id} acts on a client but the session names none`);
    }
    const { in: where, name } = operation.location;
    if (where === "path") pathParams[name] = session.locationId;
    else if (where === "query") query[name] = session.locationId;
    else if (body) body[name] = session.locationId;
    else throw new GhlUsageError(`${operation.id} expects locationId in a body it was not given`);
  }

  const url = new URL(fillPath(operation, pathParams), options.baseUrl ?? GHL_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    Version: operation.version,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await (options.fetch ?? fetch)(url, {
    method: operation.method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw toGhlError(operation.id, res.status, payload);
  return payload as T;
}

function rejectCallerLocationId(operation: GhlOperation, input: GhlRequestInput): void {
  for (const source of [input.path, input.query, input.body]) {
    if (source && "locationId" in source) {
      throw new GhlUsageError(
        `${operation.id}: locationId comes from the session, never from the caller`,
      );
    }
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
