/**
 * How a Locus backend off Vercel (the agent server) vouches to the web app for the member and
 * client it acts for, e.g. when it drives a site's sandbox through `/api/internal/sandbox`.
 *
 * A short-lived HS256 JWT, like the chat kit's (`chat-kit.ts`), with its key derived from
 * `BETTER_AUTH_SECRET` under its own label ("locus-agent-to-web"), so a chat kit token is never
 * accepted here nor one of these by the agent server. The token only names who: the web app
 * loads the member itself and runs the staff check again before it does anything.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** The longest a token may still be valid for. */
const MAX_TOKEN_MS = 10 * 60 * 1000;
/** What `mintAgentToWebToken` signs for unless told otherwise. */
const DEFAULT_TOKEN_MS = 5 * 60 * 1000;
const AUDIENCE = "locus-web";

/** Who an agent-to-web token speaks for. */
export interface AgentToWebClaims {
  /** The Better Auth `member` row id (the token's `sub`). */
  memberId: string;
  /** The client (GHL location) the call is for. */
  locationId: string;
  /** The agency (Better Auth organisation) the member and client belong to. */
  organizationId: string;
}

/** The HMAC key for agent-to-web tokens, from the Better Auth secret. */
export function agentToWebKey(authSecret: string): string {
  return Buffer.from(hkdfSync("sha256", authSecret, "locus", "locus-agent-to-web", 32)).toString(
    "base64url",
  );
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Signs a token for `claims`, valid for `ttlMs` (at most 10 minutes; default 5). */
export function mintAgentToWebToken(
  key: string,
  claims: AgentToWebClaims,
  opts: { ttlMs?: number; now?: number } = {},
): string {
  const ttl = opts.ttlMs ?? DEFAULT_TOKEN_MS;
  if (!(ttl > 0 && ttl <= MAX_TOKEN_MS)) throw new Error("token lifetime must be up to 10 minutes");
  for (const value of [claims.memberId, claims.locationId, claims.organizationId]) {
    if (typeof value !== "string" || !value) throw new Error("token needs member, client, agency");
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: claims.memberId,
    loc: claims.locationId,
    org: claims.organizationId,
    aud: AUDIENCE,
    iat: now,
    exp: now + Math.floor(ttl / 1000),
  })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/**
 * The claims of an agent-to-web token, or null when it is malformed, not signed with `key`, not
 * HS256, for another audience, expired, or valid for longer than 10 minutes.
 */
export function verifyAgentToWebToken(
  token: string,
  key: string,
  now = Date.now(),
): AgentToWebClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { alg } = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const { sub, loc, org, aud, exp } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (alg !== "HS256" || aud !== AUDIENCE) return null;
    if (typeof exp !== "number") return null;
    for (const value of [sub, loc, org]) if (typeof value !== "string" || !value) return null;
    if (exp * 1000 <= now || exp * 1000 - now > MAX_TOKEN_MS) return null;
    return { memberId: sub, locationId: loc, organizationId: org };
  } catch {
    return null;
  }
}
