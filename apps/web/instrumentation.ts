// Runs once per server instance, before it serves requests.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { settingsProblems } = await import("./lib/settings-check");
  for (const problem of settingsProblems(process.env)) {
    console.error(`Locus is not configured: ${problem}`);
  }
}
