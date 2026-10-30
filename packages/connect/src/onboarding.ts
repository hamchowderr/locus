import type { ControlDb } from "@locus/db";
import {
  agencyGhlConnection,
  agencyOnboarding,
  githubInstallation,
  hostConnection,
  location,
} from "@locus/db/control";
import { and, eq } from "drizzle-orm";

/**
 * A new agency's first-run setup, in order: connect GoHighLevel, pick its main sub-account (its
 * own business), connect GitHub, connect Vercel. GitHub and Vercel can be left for later.
 * Agencies from before this have no `agency_onboarding` row and are never sent through it.
 */
export type OnboardingStep = "ghl" | "main" | "github" | "vercel";

export const ONBOARDING_STEPS: readonly OnboardingStep[] = ["ghl", "main", "github", "vercel"];

/** Starts the setup for a new agency. Running it again changes nothing. */
export async function beginOnboarding(db: ControlDb, organizationId: string): Promise<void> {
  await db.insert(agencyOnboarding).values({ organizationId }).onConflictDoNothing();
}

/**
 * The step the agency is on, or null when it has none left (or never had the setup). The last
 * step done marks the setup complete, so later disconnecting GitHub never sends anyone back.
 */
export async function onboardingStep(
  db: ControlDb,
  organizationId: string,
  opts: { now?: Date } = {},
): Promise<OnboardingStep | null> {
  const [row] = await db
    .select()
    .from(agencyOnboarding)
    .where(eq(agencyOnboarding.organizationId, organizationId));
  if (!row || row.completedAt) return null;
  const has = async (table: typeof agencyGhlConnection | typeof githubInstallation) => {
    const [found] = await db
      .select({ organizationId: table.organizationId })
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return !!found;
  };
  if (!(await has(agencyGhlConnection))) return "ghl";
  if (!row.mainLocationId) return "main";
  if (!row.githubSkipped && !(await has(githubInstallation))) return "github";
  if (!row.vercelSkipped) {
    const [host] = await db
      .select({ provider: hostConnection.provider })
      .from(hostConnection)
      .where(eq(hostConnection.organizationId, organizationId));
    if (host?.provider !== "vercel") return "vercel";
  }
  await db
    .update(agencyOnboarding)
    .set({ completedAt: opts.now ?? new Date() })
    .where(eq(agencyOnboarding.organizationId, organizationId));
  return null;
}

/**
 * Whether the agency's setup is still open: started and not yet marked complete. Unlike
 * `onboardingStep` it never completes it, so a callback that just did the last step still sends
 * the person back to the setup, which finishes it and moves on to the chat.
 */
export async function onboardingOpen(db: ControlDb, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ completedAt: agencyOnboarding.completedAt })
    .from(agencyOnboarding)
    .where(eq(agencyOnboarding.organizationId, organizationId));
  return !!row && !row.completedAt;
}

/** Records the agency's main sub-account. It must be one of the agency's own, and active. */
export async function setMainClient(
  db: ControlDb,
  organizationId: string,
  locationId: string,
): Promise<boolean> {
  const [own] = await db
    .select({ id: location.id })
    .from(location)
    .where(
      and(
        eq(location.id, locationId),
        eq(location.organizationId, organizationId),
        eq(location.status, "active"),
      ),
    );
  if (!own) return false;
  await db
    .update(agencyOnboarding)
    .set({ mainLocationId: own.id })
    .where(eq(agencyOnboarding.organizationId, organizationId));
  return true;
}

/** "Do this later" on the GitHub or Vercel step. */
export async function skipOnboardingStep(
  db: ControlDb,
  organizationId: string,
  step: "github" | "vercel",
): Promise<void> {
  await db
    .update(agencyOnboarding)
    .set(step === "github" ? { githubSkipped: true } : { vercelSkipped: true })
    .where(eq(agencyOnboarding.organizationId, organizationId));
}

/** The agency's main sub-account, if its setup recorded one and it still exists. */
export async function mainClientOf(db: ControlDb, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ mainLocationId: agencyOnboarding.mainLocationId })
    .from(agencyOnboarding)
    .where(eq(agencyOnboarding.organizationId, organizationId));
  return row?.mainLocationId ?? null;
}
