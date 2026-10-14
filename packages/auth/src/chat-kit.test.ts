import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatKitKey, chatKitSessionId } from "./chat-kit.ts";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token as the chat kit's proxy signs it (`signServerToken` in its `lib/mastra-proxy.ts`). */
function sign(key: string, sub: string, exp: number, alg = "HS256") {
  const body = `${b64({ alg, typ: "JWT" })}.${b64({ sub, iat: exp - 300, exp })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

const key = chatKitKey("auth-secret");
const now = 1_800_000_000_000;
const later = now / 1000 + 300;

describe("chat kit tokens", () => {
  it("name the session they were signed for", () => {
    expect(chatKitSessionId(sign(key, "sess-1", later), key, now)).toBe("sess-1");
  });

  it("are refused when expired, signed with another key, altered or not HS256", () => {
    expect(chatKitSessionId(sign(key, "sess-1", now / 1000), key, now)).toBeNull();
    expect(chatKitSessionId(sign(chatKitKey("other"), "sess-1", later), key, now)).toBeNull();
    const [header, , signature] = sign(key, "sess-1", later).split(".");
    const forged = `${header}.${b64({ sub: "sess-2", exp: later })}.${signature}`;
    expect(chatKitSessionId(forged, key, now)).toBeNull();
    expect(chatKitSessionId(sign(key, "sess-1", later, "none"), key, now)).toBeNull();
    expect(chatKitSessionId("not-a-token", key, now)).toBeNull();
  });

  it("use a key that is not the Better Auth secret itself", () => {
    expect(key).not.toBe("auth-secret");
    expect(chatKitKey("auth-secret")).toBe(key);
  });
});
