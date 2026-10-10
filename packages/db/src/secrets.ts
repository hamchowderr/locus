import { checkPath, type SecretCipher, type SecretStore } from "@locus/secrets";
import { and, eq } from "drizzle-orm";
import type { ControlDb } from "./client.ts";
import { secret } from "./control/schema.ts";

/**
 * Production's secret store: values sealed by `cipher` in the control database's `secret`
 * table. A value sealed under an earlier key is re-sealed under the current one when read, unless it changed in the meantime.
 */
export class DbSecretStore implements SecretStore {
  private readonly db: ControlDb;
  private readonly cipher: SecretCipher;

  constructor(db: ControlDb, cipher: SecretCipher) {
    this.db = db;
    this.cipher = cipher;
  }

  async get(path: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ sealed: secret.sealed })
      .from(secret)
      .where(eq(secret.path, checkPath(path)));
    if (!row) return undefined;
    const value = this.cipher.open(path, row.sealed);
    if (this.cipher.needsReseal(row.sealed)) {
      // Only if nothing wrote since this read: a token refreshed meanwhile must not be replaced
      // by the stale value (GHL refresh tokens stop working once used).
      await this.db
        .update(secret)
        .set({ sealed: this.cipher.seal(path, value), updatedAt: new Date() })
        .where(and(eq(secret.path, path), eq(secret.sealed, row.sealed)));
    }
    return value;
  }

  async set(path: string, value: string): Promise<void> {
    const row = {
      path: checkPath(path),
      sealed: this.cipher.seal(path, value),
      updatedAt: new Date(),
    };
    await this.db
      .insert(secret)
      .values(row)
      .onConflictDoUpdate({
        target: secret.path,
        set: { sealed: row.sealed, updatedAt: row.updatedAt },
      });
  }

  async delete(path: string): Promise<void> {
    await this.db.delete(secret).where(eq(secret.path, checkPath(path)));
  }
}
