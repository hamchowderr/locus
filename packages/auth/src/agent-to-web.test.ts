import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentToWebKey, mintAgentToWebToken, verifyAgentToWebToken } from "./agent-to-web.ts";
import { chatKitKey } from "./chat-kit.ts";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const key = agentToWebKey("auth-secret");
const now = 1_800_000_000_000;
const claims = { memberId: "mem-1", locationId: "loc-1", organizationId: "org-1" };

function sign(signingKey: string, payload: Record<string, unknown>, alg = "HS256") {
  const body = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  return `${body}.${createHmac("sha256", signingKey).update(body).digest("base64url")}`;
}

describe("agent-to-web tokens", () => {
  it("carry the member, client and agency they were minted for", () => {
    const token = mintAgentToWebToken(key, claims, { now });
    expect(verifyAgentToWebToken(token, key, now)).toEqual(claims);
    expect(verifyAgentToWebToken(token, key, now + 4 * 60_000)).toEqual(claims);
  });

  it("are refused when expired, signed with another key or label, altered or not HS256", () => {
    const token = mintAgentToWebToken(key, claims, { now });
    expect(verifyAgentToWebToken(token, key, now + 5 * 60_000)).toBeNull();
    expect(verifyAgentToWebToken(token, agentToWebKey("other"), now)).toBeNull();
    // A chat kit key (same secret, other label) neither signs nor verifies these.
    expect(
      verifyAgentToWebToken(
        mintAgentToWebToken(chatKitKey("auth-secret"), claims, { now }),
        key,
        now,
      ),
    ).toBeNull();
    expect(agentToWebKey("auth-secret")).not.toBe(chatKitKey("auth-secret"));
    const [header, , signature] = token.split(".");
    const forged = `${header}.${b64({ sub: "mem-2", loc: "loc-2", org: "org-1", aud: "locus-web", exp: now / 1000 + 60 })}.${signature}`;
    expect(verifyAgentToWebToken(forged, key, now)).toBeNull();
    const payload = {
      sub: "mem-1",
      loc: "loc-1",
      org: "org-1",
      aud: "locus-web",
      exp: now / 1000 + 60,
    };
    expect(verifyAgentToWebToken(sign(key, payload, "none"), key, now)).toBeNull();
    expect(verifyAgentToWebToken(sign(key, { ...payload, aud: "agent" }), key, now)).toBeNull();
    expect(verifyAgentToWebToken(sign(key, { ...payload, loc: "" }), key, now)).toBeNull();
    expect(verifyAgentToWebToken("not-a-token", key, now)).toBeNull();
  });

  it("are refused when valid for more than 10 minutes, and are never minted so", () => {
    const payload = { sub: "mem-1", loc: "loc-1", org: "org-1", aud: "locus-web" };
    expect(
      verifyAgentToWebToken(sign(key, { ...payload, exp: now / 1000 + 600 }), key, now),
    ).toEqual(claims);
    expect(
      verifyAgentToWebToken(sign(key, { ...payload, exp: now / 1000 + 601 }), key, now),
    ).toBeNull();
    expect(() => mintAgentToWebToken(key, claims, { ttlMs: 11 * 60_000 })).toThrow();
    expect(() => mintAgentToWebToken(key, { ...claims, locationId: "" })).toThrow();
  });
});
