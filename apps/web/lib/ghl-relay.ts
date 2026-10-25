/**
 * Passing copies of GHL's new-message webhooks on to another Locus, for testing. One GHL app has
 * one webhook address, so only one deployment (production) hears from GHL; with
 * `LOCUS_GHL_RELAY_URL` set, it sends each new message it has verified on to that address
 * (staging's `/api/webhooks/crm`), unchanged and with GHL's own signature. The receiver checks
 * the signature itself, so the copy proves nothing more than GHL's original did, and a relayed
 * copy is never relayed again.
 */

/** Marks a relayed copy, so a deployment set up to relay never passes it on again. */
export const RELAYED_HEADER = "x-locus-relayed";

/** The address copies go to: `https` only, and never this deployment's own. */
export function relayTarget(env: Record<string, string | undefined> = process.env): URL | null {
  const raw = env.LOCUS_GHL_RELAY_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? url : null;
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
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error(`Relaying a new GHL message to ${target.host} got ${res.status}`);
  } catch (error) {
    console.error(`Relaying a new GHL message to ${target.host} failed`, error);
  }
}
