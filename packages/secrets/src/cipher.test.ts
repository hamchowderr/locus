import { describe, expect, it } from "vitest";
import { generateSecretsKey, SecretCipher, SecretUnreadable } from "./cipher.ts";

const key = () => Buffer.from(generateSecretsKey(), "base64");

describe("SecretCipher", () => {
  it("round-trips, and the sealed value reveals nothing of the plaintext", () => {
    const cipher = new SecretCipher(key());
    const sealed = cipher.seal("/locus/ghl/org-1", "access-token-123");
    expect(sealed).not.toContain("access-token-123");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(cipher.open("/locus/ghl/org-1", sealed)).toBe("access-token-123");
  });

  it("never seals the same value the same way twice", () => {
    const cipher = new SecretCipher(key());
    expect(cipher.seal("/locus/ghl/org-1", "x")).not.toBe(cipher.seal("/locus/ghl/org-1", "x"));
  });

  it("refuses a value moved to another path, such as another agency's", () => {
    const cipher = new SecretCipher(key());
    const sealed = cipher.seal("/locus/ghl/org-1", "token");
    expect(() => cipher.open("/locus/ghl/org-2", sealed)).toThrow(SecretUnreadable);
  });

  it("refuses a tampered value and a different key", () => {
    const cipher = new SecretCipher(key());
    const sealed = cipher.seal("/locus/ghl/org-1", "token");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3] as string, "base64url");
    body[0] = (body[0] as number) ^ 1;
    parts[3] = body.toString("base64url");
    expect(() => cipher.open("/locus/ghl/org-1", parts.join("."))).toThrow(/integrity/);
    expect(() => new SecretCipher(key()).open("/locus/ghl/org-1", sealed)).toThrow(/unknown key/);
    expect(() => cipher.open("/locus/ghl/org-1", "not-sealed")).toThrow(SecretUnreadable);
  });

  it("keeps opening values sealed under a previous key, and says they need resealing", () => {
    const oldKey = key();
    const sealed = new SecretCipher(oldKey).seal("/locus/ghl/org-1", "token");
    const rotated = new SecretCipher(key(), [oldKey]);
    expect(rotated.open("/locus/ghl/org-1", sealed)).toBe("token");
    expect(rotated.needsReseal(sealed)).toBe(true);
    expect(rotated.needsReseal(rotated.seal("/locus/ghl/org-1", "token"))).toBe(false);
  });

  it("reads its keys from the environment and rejects anything but 32 bytes", () => {
    const current = generateSecretsKey();
    const previous = generateSecretsKey();
    const sealed = SecretCipher.fromEnv({ LOCUS_SECRETS_KEY: previous }).seal("/locus/a", "v");
    const cipher = SecretCipher.fromEnv({
      LOCUS_SECRETS_KEY: current,
      LOCUS_SECRETS_KEY_PREVIOUS: ` ${previous} `,
    });
    expect(cipher.open("/locus/a", sealed)).toBe("v");
    expect(() => SecretCipher.fromEnv({})).toThrow(/LOCUS_SECRETS_KEY is not set/);
    expect(() => SecretCipher.fromEnv({ LOCUS_SECRETS_KEY: "c2hvcnQ=" })).toThrow(
      /32 random bytes/,
    );
  });

  it("never puts the value or the key in an error", () => {
    const secretKey = generateSecretsKey();
    const cipher = SecretCipher.fromEnv({ LOCUS_SECRETS_KEY: secretKey });
    const sealed = cipher.seal("/locus/ghl/org-1", "super-secret-token");
    try {
      cipher.open("/locus/ghl/org-2", sealed);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-token");
      expect(String(error)).not.toContain(secretKey);
    }
  });
});
