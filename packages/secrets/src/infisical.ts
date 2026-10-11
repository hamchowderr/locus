// Production settings from Infisical at server start. The deployment holds only a machine
// identity (Universal Auth) that can read one folder; every other value is fetched here.
//
// Contract read from infisical.com/docs/api-reference (2026-10-11):
//   POST /api/v1/auth/universal-auth/login  { clientId, clientSecret } -> { accessToken }
//   GET  /api/v4/secrets?projectId&environment&secretPath&includeImports&...
//        -> { secrets: [{ secretKey, secretValue }], imports: [{ secretPath, secrets }] }
// (The older /api/v3/secrets/raw, which the Node SDK still calls, is listed as deprecated.)
// A folder's own secrets win over the folders it imports (here /locus over /shared).

type Env = Record<string, string | undefined>;

export interface InfisicalLoadResult {
  /** Names set from Infisical. Never the values. */
  loaded: string[];
  /** Names Infisical has but the environment already set, which therefore win. */
  kept: string[];
}

/** Raised on any failure. Carries what failed, never a credential or a value. */
export class InfisicalLoadError extends Error {
  override name = "InfisicalLoadError";
}

interface RawSecret {
  secretKey?: string;
  secretValue?: string;
}

const BOOTSTRAP = /^INFISICAL_/;

/** True when the environment carries a machine identity to load with. */
export const infisicalConfigured = (env: Env = process.env) =>
  Boolean(env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID);

/**
 * Logs in with the machine identity, reads the folder (and what it imports) and copies each
 * value into `env` unless `env` already has it. Values are never returned or logged.
 *
 * Settings: INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET,
 * INFISICAL_PROJECT_ID; optional INFISICAL_ENVIRONMENT (prod), INFISICAL_SECRET_PATH (/locus),
 * INFISICAL_SITE_URL (https://app.infisical.com).
 */
export async function loadInfisicalEnv(
  env: Env = process.env,
  deps: { fetch?: typeof fetch } = {},
): Promise<InfisicalLoadResult> {
  const f = deps.fetch ?? fetch;
  const clientId = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
  const clientSecret = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
  const projectId = env.INFISICAL_PROJECT_ID;
  const missing = [
    !clientId && "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    !clientSecret && "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    !projectId && "INFISICAL_PROJECT_ID",
  ].filter(Boolean);
  if (missing.length > 0) throw new InfisicalLoadError(`${missing.join(", ")} not set`);

  const site = (env.INFISICAL_SITE_URL ?? "https://app.infisical.com").replace(/\/+$/, "");
  const environment = env.INFISICAL_ENVIRONMENT ?? "prod";
  const secretPath = env.INFISICAL_SECRET_PATH ?? "/locus";

  const login = await f(`${site}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const auth = (await login.json().catch(() => ({}))) as { accessToken?: string };
  if (!login.ok || !auth.accessToken) {
    throw new InfisicalLoadError(`Infisical login failed (HTTP ${login.status})`);
  }

  const query = new URLSearchParams({
    projectId: projectId as string,
    environment,
    secretPath,
    includeImports: "true",
    expandSecretReferences: "true",
    recursive: "false",
    viewSecretValue: "true",
  });
  const list = await f(`${site}/api/v4/secrets?${query}`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  const body = (await list.json().catch(() => ({}))) as {
    secrets?: RawSecret[];
    imports?: { secrets?: RawSecret[] }[];
  };
  if (!list.ok || !Array.isArray(body.secrets)) {
    throw new InfisicalLoadError(
      `Infisical refused ${environment}:${secretPath} (HTTP ${list.status})`,
    );
  }

  // The folder's own values first, then each import's, without overriding the folder.
  const values = new Map<string, string>();
  for (const secret of [...body.secrets, ...(body.imports ?? []).flatMap((i) => i.secrets ?? [])]) {
    if (secret.secretKey && secret.secretValue !== undefined && !values.has(secret.secretKey)) {
      values.set(secret.secretKey, secret.secretValue);
    }
  }

  const result: InfisicalLoadResult = { loaded: [], kept: [] };
  for (const [name, value] of values) {
    if (BOOTSTRAP.test(name)) continue;
    if (env[name] !== undefined && env[name] !== "") {
      result.kept.push(name);
      continue;
    }
    env[name] = value;
    result.loaded.push(name);
  }
  return result;
}
