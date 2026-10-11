/**
 * The deployment's own address, for sign-in links, OAuth callbacks and Stripe's return pages.
 *
 * A Vercel preview uses its branch URL (`locus-git-<branch>-<team>.vercel.app`), which stays the
 * same for every deploy of that branch — so the `staging` branch has one fixed address Stripe's
 * test-mode webhook can call, and each pull request's preview links back to itself rather than
 * to whatever `BETTER_AUTH_URL` the shared Preview settings hold. Everywhere else it is
 * `BETTER_AUTH_URL`.
 */
export function deploymentBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.VERCEL_ENV === "preview" && env.VERCEL_BRANCH_URL) {
    return `https://${env.VERCEL_BRANCH_URL}`;
  }
  return env.BETTER_AUTH_URL;
}
