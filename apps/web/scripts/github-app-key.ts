// Puts the Locus GitHub App's private key in the deployment's secret store, where publishing
// reads it. Never an environment variable.
//   pnpm --filter @locus/web github-app-key < locus-app.private-key.pem
// With the deployment's LOCUS_CONTROL_DB_URL, LOCUS_CONTROL_DB_TOKEN, LOCUS_SECRETS and
// LOCUS_SECRETS_KEY in the environment (e.g. `infisical run --path=/locus -- …`); locally it
// writes `.data/secrets.json`. The key is checked, sealed and stored; it is never printed.
import { createPrivateKey } from "node:crypto";
import { DbSecretStore, DEV_CONTROL_DB_URL, openControlDb } from "@locus/db";
import { secretsFromEnv } from "@locus/secrets";
import { GITHUB_APP_KEY_SECRET } from "../lib/github-app.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const pem = Buffer.concat(chunks).toString("utf8").trim();
try {
  createPrivateKey(pem);
} catch {
  console.error("That isn't a PEM private key. Pipe the GitHub App's .pem file in.");
  process.exit(1);
}

const url =
  process.env.LOCUS_CONTROL_DB_URL ??
  (process.env.NODE_ENV === "production" ? undefined : DEV_CONTROL_DB_URL);
if (!url) {
  console.error("Set LOCUS_CONTROL_DB_URL (and LOCUS_CONTROL_DB_TOKEN for Turso).");
  process.exit(1);
}
const db = openControlDb(url, process.env.LOCUS_CONTROL_DB_TOKEN);
const store = secretsFromEnv({
  localFile: ".data/secrets.json",
  encrypted: (cipher) => new DbSecretStore(db, cipher),
});
await store.set(GITHUB_APP_KEY_SECRET, `${pem}\n`);
db.$client.close();
console.log(`GitHub App private key stored at ${GITHUB_APP_KEY_SECRET}.`);
