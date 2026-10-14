import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { ConnectError, type GithubAppCredentials, STUB_GITHUB_APP_ID } from "@locus/connect";
import { type ControlDb, DbSecretStore, openControlDb } from "@locus/db";
import { LocalSecretStore, SecretCipher, type SecretStore } from "@locus/secrets";

/**
 * Where the Locus GitHub App's private key lives: the deployment's secret store (sealed in the
 * control database with `LOCUS_SECRETS_KEY` in production), never an environment variable. Put
 * it there with `pnpm --filter @locus/web github-app-key < key.pem`.
 */
export const GITHUB_APP_KEY_SECRET = "/locus/github-app/private-key";

/**
 * The live app's credentials: the client id as the JWT's issuer (GitHub's recommendation), and
 * the key read from the secret store each time a JWT is signed. Nothing keeps the key.
 */
export function liveGithubApp(clientId: string, store: () => SecretStore): GithubAppCredentials {
  return {
    appId: clientId,
    privateKey: async () => {
      const key = await store().get(GITHUB_APP_KEY_SECRET);
      if (!key) {
        console.error(
          `Locus is not configured: no GitHub App private key at ${GITHUB_APP_KEY_SECRET}`,
        );
        throw new ConnectError("Publishing to GitHub isn't set up on this deployment yet.");
      }
      return key;
    },
  };
}

let stubKey: string | undefined;

/** `GITHUB_MODE=stub`: the stub checks only the issuer, so a throwaway key is enough. */
export function stubGithubApp(): GithubAppCredentials {
  return {
    appId: STUB_GITHUB_APP_ID,
    privateKey: async () => {
      stubKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      return stubKey;
    },
  };
}

/** The GitHub App key could not be stored; the message says why and holds no key material. */
export class GithubAppKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppKeyError";
  }
}

/**
 * Checks and stores the GitHub App's private key (`github-app-key` script).
 *
 * It goes where the app will look for it (`secretsFromEnv`): sealed with `LOCUS_SECRETS_KEY` in
 * the control database (`LOCUS_CONTROL_DB_URL`) in production or with `LOCUS_SECRETS=encrypted`,
 * otherwise to the local development file, unencrypted, and the result says so. Production
 * never takes the local file.
 */
export async function storeGithubAppKey(
  pem: string,
  env: Record<string, string | undefined>,
  options: { localFile?: string; openDb?: (url: string, token?: string) => ControlDb } = {},
): Promise<{ store: "encrypted"; url: string } | { store: "local"; file: string }> {
  let type: string | undefined;
  try {
    type = createPrivateKey(pem).asymmetricKeyType;
  } catch {
    throw new GithubAppKeyError(
      "That isn't a PEM private key. Pipe the GitHub App's .pem file in.",
    );
  }
  if (type !== "rsa") {
    throw new GithubAppKeyError(`GitHub App keys are RSA; that one is ${type ?? "unknown"}.`);
  }
  const value = `${pem.trim()}\n`;
  // The same choice the app makes when it reads the key (`secretsFromEnv`), so they agree.
  const production = env.NODE_ENV === "production";
  const mode = env.LOCUS_SECRETS ?? (production ? "encrypted" : "local");
  if (mode === "local") {
    if (production) {
      throw new GithubAppKeyError(
        "In production the key is only stored sealed; unset LOCUS_SECRETS.",
      );
    }
    const file = options.localFile ?? ".data/secrets.json";
    await new LocalSecretStore(file, env).set(GITHUB_APP_KEY_SECRET, value);
    return { store: "local", file };
  }
  if (mode !== "encrypted") {
    throw new GithubAppKeyError(`LOCUS_SECRETS must be "local" or "encrypted" (got ${mode}).`);
  }
  const url = env.LOCUS_CONTROL_DB_URL;
  if (!url) {
    throw new GithubAppKeyError("Set LOCUS_CONTROL_DB_URL (and LOCUS_CONTROL_DB_TOKEN).");
  }
  const cipher = (() => {
    try {
      return SecretCipher.fromEnv(env);
    } catch (error) {
      throw new GithubAppKeyError((error as Error).message);
    }
  })();
  const db = (options.openDb ?? openControlDb)(url, env.LOCUS_CONTROL_DB_TOKEN);
  try {
    await new DbSecretStore(db, cipher).set(GITHUB_APP_KEY_SECRET, value);
  } finally {
    db.$client.close();
  }
  return { store: "encrypted", url };
}
