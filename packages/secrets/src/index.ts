import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SecretCipher } from "./cipher.ts";

export { generateSecretsKey, SecretCipher, SecretUnreadable } from "./cipher.ts";
export {
  InfisicalLoadError,
  type InfisicalLoadResult,
  infisicalConfigured,
  loadInfisicalEnv,
} from "./infisical.ts";

/**
 * Where credentials live, addressed by path (`secretRef`, e.g. `/locus/ghl/<organizationId>`).
 * In production that is the control database, sealed with `SecretCipher`: a leaked database
 * alone must not leak a single token, and nobody browsing Infisical sees agencies' tokens.
 */
export interface SecretStore {
  get(path: string): Promise<string | undefined>;
  set(path: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
}

const PATH = /^\/locus(\/[A-Za-z0-9_-]+)+$/;

export function checkPath(path: string): string {
  if (!PATH.test(path)) throw new Error(`Not a Locus secret path: ${path}`);
  return path;
}

/** For tests. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(path: string) {
    return this.values.get(checkPath(path));
  }
  async set(path: string, value: string) {
    this.values.set(checkPath(path), value);
  }
  async delete(path: string) {
    this.values.delete(checkPath(path));
  }
}

/**
 * Local development only: a JSON file readable by the owner alone. Refuses to run in
 * production, where agencies' tokens are sealed in the control database.
 */
export class LocalSecretStore implements SecretStore {
  readonly file: string;

  constructor(file: string, env: Record<string, string | undefined> = process.env) {
    if (env.NODE_ENV === "production") {
      throw new Error("LocalSecretStore is for local development only");
    }
    this.file = file;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(values: Record<string, string>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(values, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async get(path: string) {
    return (await this.read())[checkPath(path)];
  }
  async set(path: string, value: string) {
    const values = await this.read();
    values[checkPath(path)] = value;
    await this.write(values);
  }
  async delete(path: string) {
    const values = await this.read();
    delete values[checkPath(path)];
    await this.write(values);
  }
}

export interface SecretStoreOptions {
  /** The development file for `local`. */
  localFile: string;
  /** Builds the database-backed store for `encrypted`; it lives in `@locus/db`. */
  encrypted: (cipher: SecretCipher) => SecretStore;
}

/**
 * `LOCUS_SECRETS=local` (the default outside production) or `encrypted` (the default, and the
 * only choice, in production): agencies' tokens sealed with `LOCUS_SECRETS_KEY` in the control
 * database. The key itself lives in Infisical `/locus`.
 */
export function secretsFromEnv(
  options: SecretStoreOptions,
  env: Record<string, string | undefined> = process.env,
): SecretStore {
  const mode = env.LOCUS_SECRETS ?? (env.NODE_ENV === "production" ? "encrypted" : "local");
  if (mode === "local") return new LocalSecretStore(options.localFile, env);
  if (mode === "encrypted") return options.encrypted(SecretCipher.fromEnv(env));
  throw new Error(`LOCUS_SECRETS must be "local" or "encrypted" (got ${mode})`);
}
