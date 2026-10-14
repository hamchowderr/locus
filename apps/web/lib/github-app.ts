import { generateKeyPairSync } from "node:crypto";
import { ConnectError, type GithubAppCredentials, STUB_GITHUB_APP_ID } from "@locus/connect";
import type { SecretStore } from "@locus/secrets";

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
