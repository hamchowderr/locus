/**
 * A GHL API operation, described once and executed only through `ghlRequest`.
 *
 * The version lives here, per operation, because GHL's versions are per operation: most v3
 * operations take `Version: v3`, some still take a date version, and a few already point at
 * `v4`. The official SDK sends one global version, which is why it is never called directly.
 */

export type GhlVersion = "v4" | "v3" | "2023-02-21" | "2021-07-28" | "2021-04-15";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Which token the operation accepts: a sub-account (location) or an agency (company). */
export type TokenKind = "location" | "agency";

/**
 * Where the operation expects the client's `locationId`, if anywhere. The request layer fills
 * it from the session; callers can never supply it themselves.
 */
export type LocationParam = { in: "path" | "query" | "body"; name: string } | undefined;

export interface GhlOperation {
  /** Stable id, `<service>.<operation>`, e.g. `contacts.search-contacts-advanced`. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Path template, e.g. `/contacts/{contactId}`. */
  readonly path: string;
  readonly version: GhlVersion;
  readonly token: TokenKind;
  readonly scopes: readonly string[];
  readonly location?: LocationParam;
}

export function defineOperation<const T extends GhlOperation>(operation: T): T {
  return operation;
}

/** Anything other than a GET changes data in GHL and goes through the write gate. */
export function isWrite(operation: GhlOperation): boolean {
  return operation.method !== "GET";
}
