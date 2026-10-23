import type { ControlDb } from "@locus/db";
import { user } from "@locus/db/control";
import { eq } from "drizzle-orm";

/**
 * Records the agency the user just made active, so their next sign-in opens it. Call it only
 * after Better Auth's `setActiveOrganization` succeeded, which checks the membership; the
 * session-create hook checks it again before using the value.
 */
export async function rememberAgency(
  db: ControlDb,
  userId: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(user)
    .set({ lastActiveOrganizationId: organizationId })
    .where(eq(user.id, userId));
}
