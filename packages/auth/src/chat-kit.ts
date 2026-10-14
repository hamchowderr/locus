/**
 * How the web app vouches for a signed-in session to the agent server when the chat kit's
 * proxy forwards a request (it sends a short-lived HS256 JWT, not the browser's cookie).
 *
 * The key is derived from `BETTER_AUTH_SECRET`, which both already hold, so there is no new
 * secret to share. The token's `sub` is the Better Auth session id; the agent server loads
 * that session itself and runs the usual checks on it, so the token proves only that the web
 * app saw that session signed in within the last few minutes.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** The HMAC key for chat kit tokens, from the Better Auth secret. */
export function chatKitKey(authSecret: string): string {
  return Buffer.from(
    hkdfSync("sha256", authSecret, "locus", "locus chat kit token v1", 32),
  ).toString("base64url");
}

/**
 * The session id a chat kit token names, or null when the token is malformed, not signed with
 * `key`, or expired. Accepts only HS256, as the kit's proxy signs it.
 */
export function chatKitSessionId(token: string, key: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { alg } = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (alg !== "HS256") return null;
    if (typeof sub !== "string" || !sub || typeof exp !== "number") return null;
    if (exp * 1000 <= now) return null;
    return sub;
  } catch {
    return null;
  }
}
