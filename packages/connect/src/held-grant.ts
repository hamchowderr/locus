import type { ConnectDeps } from "./agency.ts";
import type { AgencyGrant } from "./ghl-oauth.ts";

/**
 * GoHighLevel marketplace installs arrive with a code and no Locus session or state: the agency
 * started in GoHighLevel, not in Locus. The code is exchanged at once (it expires in minutes) and
 * the grant is held here, sealed like any other, until the person signs in and confirms which
 * Locus agency it belongs to. Nothing is connected without that confirmation.
 */
export const HELD_GRANT_MS = 60 * 60_000;

const heldRef = (id: string) => `/locus/ghl-held/${id}`;
const ID = /^[A-Za-z0-9_-]{16,64}$/;

interface Held {
  grant: AgencyGrant;
  heldUntil: number;
}

/** Holds a grant for an hour. Returns the id to keep in the installer's browser. */
export async function holdGrant(
  deps: Pick<ConnectDeps, "secrets" | "now">,
  grant: AgencyGrant,
): Promise<string> {
  const id = crypto.randomUUID().replaceAll("-", "");
  const held: Held = { grant, heldUntil: (deps.now?.() ?? Date.now()) + HELD_GRANT_MS };
  await deps.secrets.set(heldRef(id), JSON.stringify(held));
  return id;
}

/** The held grant, if it is still there and in time. Leaves it held. */
export async function peekHeldGrant(
  deps: Pick<ConnectDeps, "secrets" | "now">,
  id: string | undefined,
): Promise<AgencyGrant | null> {
  if (!id || !ID.test(id)) return null;
  const stored = await deps.secrets.get(heldRef(id));
  if (!stored) return null;
  const held = JSON.parse(stored) as Held;
  if (held.heldUntil <= (deps.now?.() ?? Date.now())) {
    await deps.secrets.delete(heldRef(id));
    return null;
  }
  return held.grant;
}

/** Takes the held grant out, so it can be used once. */
export async function takeHeldGrant(
  deps: Pick<ConnectDeps, "secrets" | "now">,
  id: string | undefined,
): Promise<AgencyGrant | null> {
  const grant = await peekHeldGrant(deps, id);
  if (grant && id) await deps.secrets.delete(heldRef(id));
  return grant;
}
