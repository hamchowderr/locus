/**
 * A GHL API operation, described once and executed only through `ghlRequest`.
 *
 * The version lives here, per operation, because GHL's versions are per operation: today every
 * v3 operation takes `Version: v3`, but GHL already points some deprecated ones at `v4`, and the
 * official SDK sends one global version — which is why it is never called directly.
 */

export type GhlVersion = "v4" | "v3" | "2023-02-21" | "2021-07-28" | "2021-04-15";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A sub-account (location) token or an agency (company) token. */
export type TokenKind = "location" | "agency";

/**
 * A parameter whose value comes from the session, never from the caller:
 * - `locationId` — the client the session acts on (named `locationId` or `altId` in GHL)
 * - `companyId` — the agency the session belongs to
 * - `altType` — the literal `"location"` that GHL pairs with `altId`
 */
export interface SessionParam {
  readonly in: "path" | "query" | "body";
  readonly name: string;
  readonly value: "locationId" | "companyId" | "altType";
  /** A required parameter fails the request when the session cannot supply it. */
  readonly required: boolean;
}

export interface GhlOperation {
  /** Stable id, `<service>.<docs-slug>`, e.g. `contacts.search-contacts-advanced`. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Path template, e.g. `/contacts/{contactId}`. */
  readonly path: string;
  readonly version: GhlVersion;
  /** Token kinds GHL accepts for this operation. Empty means it takes no auth at all. */
  readonly tokens: readonly TokenKind[];
  readonly scopes: readonly string[];
  readonly sessionParams?: readonly SessionParam[];
  /** How the request body is encoded, when there is one. JSON, form and multipart are sent. */
  readonly body?: "json" | "multipart" | "form";
}

export function defineOperation<const T extends GhlOperation>(operation: T): T {
  return operation;
}

/** Anything other than a GET changes data in GHL and goes through the write gate. */
export function isWrite(operation: GhlOperation): boolean {
  return operation.method !== "GET";
}
