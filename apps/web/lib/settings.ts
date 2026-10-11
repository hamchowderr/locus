import { infisicalConfigured, loadInfisicalEnv } from "@locus/secrets";

/**
 * Production reads its settings from Infisical (prod:/locus, which imports /shared) at start-up,
 * using the machine identity in INFISICAL_UNIVERSAL_AUTH_CLIENT_* — the only credential the
 * deployment holds. Without that identity (local development, tests) nothing happens.
 *
 * A failure is logged, never thrown: the app then answers "Locus is not configured" (503)
 * for anything that needs a missing setting, and the next server instance tries again.
 */
export async function loadSettings(): Promise<void> {
  if (!infisicalConfigured()) return;
  try {
    const { loaded, kept } = await loadInfisicalEnv();
    console.info(
      `Settings: ${loaded.length} loaded from Infisical` +
        (kept.length > 0 ? `; ${kept.length} already set here and kept (${kept.join(", ")})` : ""),
    );
  } catch (error) {
    console.error(`Settings: loading from Infisical failed: ${(error as Error).message}`);
  }
}
