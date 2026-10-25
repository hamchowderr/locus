/**
 * Passing copies of GHL's new-message webhooks on to another Locus, for testing. One GHL app has
 * one webhook address, so only one deployment (production) hears from GHL; with
 * `LOCUS_GHL_RELAY_URL` set, it sends each new message it has verified on to that address
 * (staging's `/api/webhooks/crm`), unchanged and with GHL's own signature. The receiver checks
 * the signature itself, so the copy proves nothing more than GHL's original did, and a relayed
 * copy is never relayed again. Only the GHL locations listed in `LOCUS_GHL_RELAY_LOCATIONS` are
 * relayed (test sub-accounts): no other client's messages leave production.
 */

/** Marks a relayed copy, so a deployment set up to relay never passes it on again. */
export const RELAYED_HEADER = "x-locus-relayed";

/**
 * Where a new message in this GHL location is copied to, if anywhere: `https` only, never this
 * deployment's own address, and only for a location on the list.
 */
export function relayTarget(
  ghlLocationId: unknown,
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const raw = env.LOCUS_GHL_RELAY_URL?.trim();
  if (!raw || typeof ghlLocationId !== "string") return null;
  const listed = (env.LOCUS_GHL_RELAY_LOCATIONS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!listed.includes(ghlLocationId)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const own = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  return own && url.host === own ? null : url;
}

/**
 * Sends the copy and waits at most a few seconds: the relay is best effort and never holds up,
 * or changes, the answer production gives GHL.
 */
export async function relayToTarget(
  target: URL,
  raw: string,
  signature: string,
  send: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await send(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghl-signature": signature,
        [RELAYED_HEADER]: "1",
      },
      body: raw,
      // A redirect would carry the message somewhere nobody chose.
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error(`Relaying a new GHL message to ${target.host} got ${res.status}`);
  } catch (error) {
    console.error(`Relaying a new GHL message to ${target.host} failed`, error);
  }
}
