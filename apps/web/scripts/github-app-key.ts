// Puts the Locus GitHub App's private key in the deployment's secret store, where publishing
// reads it. Never an environment variable.
//   pnpm --filter @locus/web github-app-key < locus-app.private-key.pem
// With LOCUS_CONTROL_DB_URL set (plus LOCUS_CONTROL_DB_TOKEN and LOCUS_SECRETS_KEY, e.g. through
// `infisical run --path=/locus -- …`) the key is sealed in that control database. Without it,
// outside production, it goes to the local development file `.data/secrets.json`, unencrypted.
// The key is checked (RSA only) and never printed.
import { GithubAppKeyError, storeGithubAppKey } from "../lib/github-app.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
try {
  const result = await storeGithubAppKey(Buffer.concat(chunks).toString("utf8"), process.env);
  console.log(
    result.store === "encrypted"
      ? `GitHub App private key sealed in the control database (${result.url.replace(/\?.*$/, "")}).`
      : `GitHub App private key written UNENCRYPTED to the local development file ${result.file}.`,
  );
} catch (error) {
  if (!(error instanceof GithubAppKeyError)) throw error;
  console.error(error.message);
  process.exit(1);
}
