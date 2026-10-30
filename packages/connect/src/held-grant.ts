import { ghlHeldInstall } from "@locus/db/control";
import { and, eq, gt, lte } from "drizzle-orm";
import type { ConnectDeps } from "./agency.ts";
import type { AgencyGrant } from "./ghl-oauth.ts";

/**
 * GoHighLevel marketplace installs arrive with a code and no Locus session or state: the agency
 * started in GoHighLevel, not in Locus. The code is exchanged at once (it expires in minutes) and
 * the grant is held here, sealed like any other, until the person signs in and confirms which
 * Locus agency it belongs to. Nothing is connected without that confirmation. Grants nobody
 * came back for are swept whenever another install is held.
 */
export const HELD_GRANT_MS = 60 * 60_000;

const heldRef = (id: string) => `/locus/ghl-held/${id}`;
const ID = /^[A-Za-z0-9_-]{16,64}$/;

type Deps = Pick<ConnectDeps, "db" | "secrets" | "now">;

/** Removes held grants whose hour is up. */
async function sweep(deps: Deps, now: number): Promise<void> {
  const expired = await deps.db
    .delete(ghlHeldInstall)
    .where(lte(ghlHeldInstall.heldUntil, new Date(now)))
    .returning({ id: ghlHeldInstall.id });
  for (const { id } of expired) await deps.secrets.delete(heldRef(id));
}

/** Holds a grant for an hour. Returns the id to keep in the installer's browser. */
export async function holdGrant(deps: Deps, grant: AgencyGrant): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  await sweep(deps, now);
  const id = crypto.randomUUID().replaceAll("-", "");
  await deps.secrets.set(heldRef(id), JSON.stringify(grant));
  await deps.db.insert(ghlHeldInstall).values({ id, heldUntil: new Date(now + HELD_GRANT_MS) });
  return id;
}

/** The held grant, if it is still there and in time. Leaves it held. */
export async function peekHeldGrant(
  deps: Deps,
  id: string | undefined,
): Promise<AgencyGrant | null> {
  if (!id || !ID.test(id)) return null;
  const now = new Date(deps.now?.() ?? Date.now());
  const [row] = await deps.db
    .select({ id: ghlHeldInstall.id })
    .from(ghlHeldInstall)
    .where(and(eq(ghlHeldInstall.id, id), gt(ghlHeldInstall.heldUntil, now)));
  if (!row) return null;
  const stored = await deps.secrets.get(heldRef(id));
  return stored ? (JSON.parse(stored) as AgencyGrant) : null;
}

/**
 * Takes the held grant out, so it is used once: of two requests racing for it, only one gets it.
 */
export async function takeHeldGrant(
  deps: Deps,
  id: string | undefined,
): Promise<AgencyGrant | null> {
  if (!id || !ID.test(id)) return null;
  const now = new Date(deps.now?.() ?? Date.now());
  const [taken] = await deps.db
    .delete(ghlHeldInstall)
    .where(and(eq(ghlHeldInstall.id, id), gt(ghlHeldInstall.heldUntil, now)))
    .returning({ id: ghlHeldInstall.id });
  if (!taken) return null;
  const stored = await deps.secrets.get(heldRef(id));
  await deps.secrets.delete(heldRef(id));
  return stored ? (JSON.parse(stored) as AgencyGrant) : null;
}

/** Lets a held grant go without using it. */
export async function dropHeldGrant(deps: Deps, id: string | undefined): Promise<void> {
  if (!id || !ID.test(id)) return;
  await deps.db.delete(ghlHeldInstall).where(eq(ghlHeldInstall.id, id));
  await deps.secrets.delete(heldRef(id));
}
