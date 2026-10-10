import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Raised when a sealed value can't be opened. Never carries the value or the key. */
export class SecretUnreadable extends Error {}

const keyId = (key: Buffer) =>
  createHash("sha256").update("locus-secret-key-id:").update(key).digest("hex").slice(0, 16);

function decodeKey(name: string, value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be ${KEY_BYTES} random bytes, base64-encoded`);
  }
  return key;
}

/**
 * Seals secrets with AES-256-GCM before they reach the database. Each value is bound to its
 * secret path (the additional authenticated data), so a sealed value copied onto another path,
 * say another agency's row, fails to open instead of handing over that agency's token.
 *
 * Sealed format: `v1.<keyId>.<iv>.<ciphertext+tag>`, base64url. Earlier keys still open what
 * they sealed, so the key can be rotated without a migration; `needsReseal` says when a value
 * should be written again under the current key.
 */
export class SecretCipher {
  private readonly currentId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(current: Buffer, previous: Buffer[] = []) {
    for (const key of [current, ...previous]) {
      if (key.length !== KEY_BYTES) throw new Error(`Secret keys must be ${KEY_BYTES} bytes`);
      this.keys.set(keyId(key), key);
    }
    this.currentId = keyId(current);
  }

  /** `LOCUS_SECRETS_KEY`, plus optional comma-separated `LOCUS_SECRETS_KEY_PREVIOUS`. */
  static fromEnv(env: Record<string, string | undefined> = process.env): SecretCipher {
    const current = env.LOCUS_SECRETS_KEY;
    if (!current) throw new Error("LOCUS_SECRETS_KEY is not set");
    const previous = (env.LOCUS_SECRETS_KEY_PREVIOUS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => decodeKey("LOCUS_SECRETS_KEY_PREVIOUS", value));
    return new SecretCipher(decodeKey("LOCUS_SECRETS_KEY", current), previous);
  }

  seal(path: string, plaintext: string): string {
    const key = this.keys.get(this.currentId) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(path));
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [VERSION, this.currentId, iv.toString("base64url"), body.toString("base64url")].join(
      ".",
    );
  }

  open(path: string, sealed: string): string {
    const [version, id, iv, body, ...rest] = sealed.split(".");
    if (version !== VERSION || !id || !iv || !body || rest.length > 0) {
      throw new SecretUnreadable(`The secret at ${path} is not in a format Locus can read`);
    }
    const key = this.keys.get(id);
    if (!key) throw new SecretUnreadable(`The secret at ${path} was sealed with an unknown key`);
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length < TAG_BYTES) {
      throw new SecretUnreadable(`The secret at ${path} is not in a format Locus can read`);
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(aad(path));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretUnreadable(`The secret at ${path} failed its integrity check`);
    }
  }

  needsReseal(sealed: string): boolean {
    return sealed.split(".")[1] !== this.currentId;
  }
}

const aad = (path: string) => Buffer.from(`locus-secret:${VERSION}:${path}`, "utf8");

/** A fresh `LOCUS_SECRETS_KEY` value. */
export const generateSecretsKey = () => randomBytes(KEY_BYTES).toString("base64");
