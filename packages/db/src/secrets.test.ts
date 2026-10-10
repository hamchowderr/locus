import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretsKey, SecretCipher, SecretUnreadable } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlDb, migrateControlDb, openControlDb } from "./client.ts";
import { secret } from "./control/index.ts";
import { DbSecretStore } from "./secrets.ts";

let dir: string;
let db: ControlDb;
const key = () => Buffer.from(generateSecretsKey(), "base64");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-secrets-db-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const rawRow = async (path: string) =>
  (await db.select().from(secret).where(eq(secret.path, path)))[0];

describe("DbSecretStore", () => {
  it("stores only sealed values, and reads, overwrites and deletes them", async () => {
    const store = new DbSecretStore(db, new SecretCipher(key()));
    await store.set("/locus/ghl/org-1", '{"access_token":"tok-1"}');
    expect((await rawRow("/locus/ghl/org-1"))?.sealed).not.toContain("tok-1");
    expect(await store.get("/locus/ghl/org-1")).toBe('{"access_token":"tok-1"}');

    await store.set("/locus/ghl/org-1", '{"access_token":"tok-2"}');
    expect(await store.get("/locus/ghl/org-1")).toBe('{"access_token":"tok-2"}');

    await store.delete("/locus/ghl/org-1");
    expect(await store.get("/locus/ghl/org-1")).toBeUndefined();
    expect(await rawRow("/locus/ghl/org-1")).toBeUndefined();
  });

  it("refuses a sealed value copied onto another agency's row", async () => {
    const store = new DbSecretStore(db, new SecretCipher(key()));
    await store.set("/locus/ghl/org-1", "org-1-token");
    const stolen = (await rawRow("/locus/ghl/org-1"))?.sealed as string;
    await db
      .insert(secret)
      .values({ path: "/locus/ghl/org-2", sealed: stolen, updatedAt: new Date() });
    await expect(store.get("/locus/ghl/org-2")).rejects.toThrow(SecretUnreadable);
  });

  it("can't be read without the key", async () => {
    await new DbSecretStore(db, new SecretCipher(key())).set("/locus/ghl/org-1", "token");
    await expect(
      new DbSecretStore(db, new SecretCipher(key())).get("/locus/ghl/org-1"),
    ).rejects.toThrow(SecretUnreadable);
  });

  it("reseals under the current key when a value sealed under the previous one is read", async () => {
    const oldKey = key();
    await new DbSecretStore(db, new SecretCipher(oldKey)).set("/locus/ghl/org-1", "token");
    const before = (await rawRow("/locus/ghl/org-1"))?.sealed;

    const newKey = key();
    const rotated = new DbSecretStore(db, new SecretCipher(newKey, [oldKey]));
    expect(await rotated.get("/locus/ghl/org-1")).toBe("token");
    const after = (await rawRow("/locus/ghl/org-1"))?.sealed;
    expect(after).not.toBe(before);
    expect(await new DbSecretStore(db, new SecretCipher(newKey)).get("/locus/ghl/org-1")).toBe(
      "token",
    );
  });

  it("never lets a reseal overwrite a value written since it was read", async () => {
    const oldKey = key();
    const newKey = key();
    await new DbSecretStore(db, new SecretCipher(oldKey)).set("/locus/ghl/org-1", "old-token");
    const rotated = new DbSecretStore(db, new SecretCipher(newKey, [oldKey]));

    // A refresh lands between the read and the reseal.
    const original = db.update.bind(db);
    let raced = false;
    db.update = ((table: typeof secret) => {
      if (!raced) {
        raced = true;
        return {
          set: (values: object) => ({
            where: async (where: unknown) => {
              await rotated.set("/locus/ghl/org-1", "new-token");
              return original(table)
                .set(values)
                .where(where as never);
            },
          }),
        };
      }
      return original(table);
    }) as never;

    expect(await rotated.get("/locus/ghl/org-1")).toBe("old-token");
    db.update = original;
    expect(await rotated.get("/locus/ghl/org-1")).toBe("new-token");
  });

  it("refuses paths outside /locus", async () => {
    const store = new DbSecretStore(db, new SecretCipher(key()));
    await expect(store.set("/other/x", "v")).rejects.toThrow(/secret path/);
  });
});
