/** Runs once per server instance, before it serves a request (Next.js `register`). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadSettings } = await import("./lib/settings");
  await loadSettings();
}
