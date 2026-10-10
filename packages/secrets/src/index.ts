import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where credentials live. The database stores only a path into this (`secretRef`), never a
 * value — a leaked control database must not leak a single token.
 */
export interface SecretStore {
  get(path: string): Promise<string | undefined>;
  set(path: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
}

const PATH = /^\/locus(\/[A-Za-z0-9_-]+)+$/;

function checkPath(path: string): string {
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
 * production, where secrets come from Infisical.
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

/**
 * `LOCUS_SECRETS=local` (the default outside production) or `infisical`. Infisical is not
 * wired yet, so production has no secret store until it is.
 */
export function secretsFromEnv(
  localFile: string,
  env: Record<string, string | undefined> = process.env,
): SecretStore {
  const mode = env.LOCUS_SECRETS ?? (env.NODE_ENV === "production" ? "infisical" : "local");
  if (mode === "local") return new LocalSecretStore(localFile, env);
  if (mode === "infisical") throw new Error("The Infisical secret store is not wired yet");
  throw new Error(`LOCUS_SECRETS must be "local" or "infisical" (got ${mode})`);
}
