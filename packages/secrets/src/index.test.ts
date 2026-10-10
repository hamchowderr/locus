import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSecretStore, MemorySecretStore, secretsFromEnv } from "./index.ts";

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

  it("never uses the local file store in production", () => {
    expect(() => new LocalSecretStore(join(dir, "s.json"), { NODE_ENV: "production" })).toThrow();
    expect(() => secretsFromEnv(join(dir, "s.json"), { NODE_ENV: "production" })).toThrow(
      /Infisical/,
    );
    expect(secretsFromEnv(join(dir, "s.json"), {})).toBeInstanceOf(LocalSecretStore);
  });
});
