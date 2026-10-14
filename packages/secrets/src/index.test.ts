import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSecretsSubkey,
  generateSecretsKey,
  LocalSecretStore,
  MemorySecretStore,
  SecretCipher,
  secretsFromEnv,
} from "./index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("secret stores", () => {
  it("stores, reads and deletes, in a file only its owner can read", async () => {
    const file = join(dir, "secrets.json");
    const store = new LocalSecretStore(file, {});
    await store.set("/locus/ghl/org-1", "token");
    expect(await new LocalSecretStore(file, {}).get("/locus/ghl/org-1")).toBe("token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.delete("/locus/ghl/org-1");
    expect(await store.get("/locus/ghl/org-1")).toBeUndefined();
  });

  it("refuses paths outside /locus", async () => {
    const store = new MemorySecretStore();
    await expect(store.set("/other/x", "v")).rejects.toThrow(/secret path/);
    await expect(store.get("/locus/../x")).rejects.toThrow(/secret path/);
  });

  it("never uses the local file store in production; production seals into the database", () => {
    const options = { localFile: join(dir, "s.json"), encrypted: () => new MemorySecretStore() };
    expect(() => new LocalSecretStore(join(dir, "s.json"), { NODE_ENV: "production" })).toThrow();
    expect(() =>
      secretsFromEnv(options, { NODE_ENV: "production", LOCUS_SECRETS: "local" }),
    ).toThrow();
    expect(() => secretsFromEnv(options, { NODE_ENV: "production" })).toThrow(/LOCUS_SECRETS_KEY/);
    expect(secretsFromEnv(options, {})).toBeInstanceOf(LocalSecretStore);

    let cipher: SecretCipher | undefined;
    const store = secretsFromEnv(
      {
        ...options,
        encrypted: (c) => {
          cipher = c;
          return new MemorySecretStore();
        },
      },
      { NODE_ENV: "production", LOCUS_SECRETS_KEY: generateSecretsKey() },
    );
    expect(store).toBeInstanceOf(MemorySecretStore);
    expect(cipher).toBeInstanceOf(SecretCipher);
    expect(() => secretsFromEnv(options, { LOCUS_SECRETS: "infisical" })).toThrow(/LOCUS_SECRETS/);
  });
});

describe("deriveSecretsSubkey", () => {
  it("derives a stable 32-byte key per label, unrelated to the sealing key", () => {
    const LOCUS_SECRETS_KEY = generateSecretsKey();
    const env = { LOCUS_SECRETS_KEY };
    const a = deriveSecretsSubkey("locus/site-lead-ip", env);
    expect(a).toHaveLength(32);
    expect(deriveSecretsSubkey("locus/site-lead-ip", env).equals(a)).toBe(true);
    expect(deriveSecretsSubkey("locus/other", env).equals(a)).toBe(false);
    expect(a.equals(Buffer.from(LOCUS_SECRETS_KEY, "base64"))).toBe(false);
    const other = { LOCUS_SECRETS_KEY: generateSecretsKey() };
    expect(deriveSecretsSubkey("locus/site-lead-ip", other).equals(a)).toBe(false);
    expect(() => deriveSecretsSubkey("locus/site-lead-ip", {})).toThrow(/LOCUS_SECRETS_KEY/);
  });
});
