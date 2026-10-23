import { missingSandboxSettings, SANDBOX_PROVIDERS } from "@locus/sandbox";

/**
 * Every setting a production deployment needs, by feature. Checked once when a server instance
 * starts (`instrumentation.ts`) so the deployment's logs name what is missing before anyone
 * clicks a button. Names only: a value is never read beyond "is it set".
 */
export const PRODUCTION_SETTINGS: Record<string, readonly string[]> = {
  core: ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "LOCUS_CONTROL_DB_URL", "LOCUS_CONTROL_DB_TOKEN"],
  email: ["RESEND_API_KEY", "EMAIL_FROM"],
  secrets: ["LOCUS_SECRETS_KEY"],
  "client databases": ["TURSO_ORG", "TURSO_GROUP", "TURSO_API_TOKEN"],
  gohighlevel: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_APP_ID"],
  github: [
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
  ],
  vercel: [
    "VERCEL_INTEGRATION_SLUG",
    "VERCEL_INTEGRATION_CLIENT_ID",
    "VERCEL_INTEGRATION_CLIENT_SECRET",
  ],
  // Vercel Sandbox, the default; only off Vercel, where the deployment's own OIDC token isn't
  // there. With `LOCUS_SANDBOX_PROVIDER=daytona` or `e2b`, that service's API key instead
  // (`missingFor`).
  "site builder": ["LOCUS_SANDBOX_TOKEN", "LOCUS_SANDBOX_TEAM_ID", "LOCUS_SANDBOX_PROJECT_ID"],
};

/** The settings a feature still lacks; the site builder's depend on its sandbox provider. */
function missingFor(
  feature: string,
  names: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  if (feature === "site builder") return missingSandboxSettings(env);
  return names.filter((name) => !env[name]);
}

const STUB_SWITCHES = ["GHL_MODE", "GITHUB_MODE", "VERCEL_MODE", "EMAIL_MODE"] as const;

/** Problems with a production environment, one line each, naming settings and never values. */
export function settingsProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const provider = env.LOCUS_SANDBOX_PROVIDER;
  const knownProvider = !provider || (SANDBOX_PROVIDERS as readonly string[]).includes(provider);
  for (const [feature, names] of Object.entries(PRODUCTION_SETTINGS)) {
    if (feature === "site builder" && !knownProvider) {
      problems.push(
        `site builder: LOCUS_SANDBOX_PROVIDER must be one of ${SANDBOX_PROVIDERS.join(", ")}`,
      );
      continue;
    }
    const missing = missingFor(feature, names, env);
    if (missing.length > 0) problems.push(`${feature}: ${missing.join(", ")} not set`);
  }
  // Billing is optional, but a key without the webhook secret records no payment.
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    problems.push("billing: STRIPE_WEBHOOK_SECRET not set");
  }
  for (const name of STUB_SWITCHES) {
    if (env[name] === "stub" || env[name] === "console")
      problems.push(`${name} is set to a development mode`);
  }
  return problems;
}
