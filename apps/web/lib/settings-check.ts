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
  "site builder": ["LOCUS_SANDBOX_TOKEN", "LOCUS_SANDBOX_TEAM_ID", "LOCUS_SANDBOX_PROJECT_ID"],
};

const STUB_SWITCHES = ["GHL_MODE", "GITHUB_MODE", "VERCEL_MODE", "EMAIL_MODE"] as const;

/** Problems with a production environment, one line each, naming settings and never values. */
export function settingsProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [feature, names] of Object.entries(PRODUCTION_SETTINGS)) {
    const missing = names.filter((name) => !env[name]);
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
