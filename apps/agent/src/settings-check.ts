import { type ControlDb, type TenantProvisioner, TursoProvisioner } from "@locus/db";
import { getProviderConfig, parseModelString } from "@mastra/core/llm";
import { SCRIPTED } from "./scripted-model.ts";

type Env = Record<string, string | undefined>;

/** The settings the agent server reads. Names only: a value is never logged. */
export const AGENT_SETTINGS = [
  "LOCUS_CONTROL_DB_URL",
  "LOCUS_CONTROL_DB_TOKEN",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "LOCUS_SECRETS_KEY",
  "GHL_CLIENT_ID",
  "GHL_CLIENT_SECRET",
  "GHL_APP_ID",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_API_TOKEN",
  "LOCUS_AGENT_MODEL",
  "LOCUS_WEB_VERCEL_BYPASS",
  "COMPOSIO_API_KEY",
  "LOCUS_PROVISIONER",
  "LOCUS_OPERATORS",
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;

// A reference some other tool was meant to fill in (`${dev.shared.X}`, `{{team.X}}`), passed
// through as text. Coolify does not resolve Infisical's syntax, and staging once ran on it.
const UNRESOLVED = /\$\{[^}]*\}|\{\{[^}]*\}\}/;

/** Settings whose value is a reference left unfilled, by name. */
export function unresolvedSettings(env: Env): string[] {
  return AGENT_SETTINGS.filter((name) => UNRESOLVED.test(env[name] ?? ""));
}

/**
 * What is wrong with `LOCUS_AGENT_MODEL`, if anything, judged against the providers in the
 * installed Mastra: a provider Mastra doesn't know (staging once ran `gateway/…`, where the
 * Vercel AI Gateway is `vercel/…`), or a missing key. Model names aren't checked: Mastra's list
 * is a snapshot, and a newer model works anyway. Only names are logged, never the raw value.
 */
export function modelProblems(env: Env): string[] {
  const id = env.LOCUS_AGENT_MODEL;
  if (!id || id === SCRIPTED || UNRESOLVED.test(id)) return [];
  const { provider } = parseModelString(id);
  if (!provider) return ["LOCUS_AGENT_MODEL is not a Mastra model id (provider/model)"];
  // Mastra's own gateway routes `mastra/…` but isn't in the provider list.
  const keys =
    provider === "mastra"
      ? ["MASTRA_GATEWAY_API_KEY"]
      : [getProviderConfig(provider)?.apiKeyEnvVar ?? []].flat();
  if (keys.length === 0) {
    return [`LOCUS_AGENT_MODEL names a provider Mastra doesn't know: ${provider}`];
  }
  if (!keys.some((key) => env[key])) {
    return [`LOCUS_AGENT_MODEL needs ${keys.join(" or ")}, which is not set`];
  }
  return [];
}

const MAX_CAUSE = 200;
/** A probe that has not answered by then is reported, so the check always logs a verdict. */
export const PROBE_TIMEOUT_MS = 10_000;

async function probe(run: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error(`no answer in ${timeoutMs} ms`))),
  );
  await Promise.race([run(signal), timedOut]);
}

function cause(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_CAUSE);
}

/**
 * What would stop the agent serving a chat, one line each, found when it starts rather than on
 * someone's first message: settings left as unfilled references, a model Mastra can't reach, a
 * control database it cannot query, and Turso refusing the settings every client database is
 * opened with.
 */
export async function settingsProblems(deps: {
  env: Env;
  db: ControlDb;
  provisioner: TenantProvisioner;
  timeoutMs?: number;
}): Promise<string[]> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const problems = unresolvedSettings(deps.env).map(
    (name) => `${name} holds an unfilled reference instead of a value`,
  );
  problems.push(...modelProblems(deps.env));
  try {
    await probe(() => deps.db.$client.execute("select 1"), timeoutMs);
  } catch (error) {
    problems.push(`the control database cannot be queried: ${cause(error)}`);
  }
  const { provisioner } = deps;
  if (provisioner instanceof TursoProvisioner) {
    try {
      await probe((signal) => provisioner.check(signal), timeoutMs);
    } catch (error) {
      problems.push(`Turso refused TURSO_ORG, TURSO_GROUP or TURSO_API_TOKEN: ${cause(error)}`);
    }
  }
  return problems;
}
