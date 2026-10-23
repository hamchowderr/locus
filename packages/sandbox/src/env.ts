import { daytonaFromEnv } from "./daytona.ts";
import { e2bFromEnv } from "./e2b.ts";
import type { RuntimeProvider } from "./runtime.ts";
import { sandboxFromEnv } from "./vercel.ts";

export const SANDBOX_PROVIDERS = ["vercel", "daytona", "e2b"] as const;
export type SandboxProviderName = (typeof SANDBOX_PROVIDERS)[number];

/**
 * Which service runs site sandboxes: `LOCUS_SANDBOX_PROVIDER`, `vercel` when unset. Throws on any
 * other value, naming the setting and never echoing it.
 */
export function sandboxProviderName(
  env: Record<string, string | undefined> = process.env,
): SandboxProviderName {
  const name = env.LOCUS_SANDBOX_PROVIDER || "vercel";
  if (!(SANDBOX_PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(`LOCUS_SANDBOX_PROVIDER must be one of ${SANDBOX_PROVIDERS.join(", ")}`);
  }
  return name as SandboxProviderName;
}

/**
 * Real sandboxes from the environment, or null when none are configured (or `LOCUS_SANDBOX=off`):
 * Daytona with `LOCUS_SANDBOX_PROVIDER=daytona` and `DAYTONA_API_KEY`, E2B with `e2b` and
 * `E2B_API_KEY`, else Vercel Sandbox (`sandboxFromEnv`).
 */
export function sandboxProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeProvider | null {
  if (env.LOCUS_SANDBOX === "off") return null;
  const name = sandboxProviderName(env);
  if (name === "daytona") return daytonaFromEnv(env);
  if (name === "e2b") return e2bFromEnv(env);
  return sandboxFromEnv(env);
}

/**
 * The settings real sandboxes still need, by name; empty when they are configured. On a Vercel
 * deployment, Vercel Sandbox needs none (its OIDC token), unless `LOCUS_SANDBOX=off`.
 */
export function missingSandboxSettings(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const name = sandboxProviderName(env);
  if (name === "daytona") return env.DAYTONA_API_KEY ? [] : ["DAYTONA_API_KEY"];
  if (name === "e2b") return env.E2B_API_KEY ? [] : ["E2B_API_KEY"];
  if (env.VERCEL === "1" && env.LOCUS_SANDBOX !== "off") return [];
  return ["LOCUS_SANDBOX_TOKEN", "LOCUS_SANDBOX_TEAM_ID", "LOCUS_SANDBOX_PROJECT_ID"].filter(
    (name) => !env[name],
  );
}
