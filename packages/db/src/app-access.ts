import { eq } from "drizzle-orm";
import type { TenantDb } from "./client.ts";
import { APP_ACCESS_VALUES, appAccess } from "./tenant/schema.ts";

/**
 * The client's settings for its connected apps, in the client's own database. Callers open it
 * with a token minted after the staff check (`openClientDb`), so these never name a client.
 */
export type StoredAppAccess = (typeof APP_ACCESS_VALUES)[number];

export function isStoredAppAccess(value: unknown): value is StoredAppAccess {
  return typeof value === "string" && (APP_ACCESS_VALUES as readonly string[]).includes(value);
}

/** Every app with a setting, by toolkit slug. Apps without one use the default. */
export async function readAppAccess(db: TenantDb): Promise<Record<string, StoredAppAccess>> {
  const rows = await db
    .select({ toolkit: appAccess.toolkit, access: appAccess.access })
    .from(appAccess);
  return Object.fromEntries(rows.map((row) => [row.toolkit, row.access]));
}

export async function writeAppAccess(
  db: TenantDb,
  toolkit: string,
  access: StoredAppAccess,
  userId: string | null,
  now = new Date(),
): Promise<void> {
  const values = { access, updatedByUserId: userId, updatedAt: now };
  await db
    .insert(appAccess)
    .values({ toolkit, ...values })
    .onConflictDoUpdate({ target: appAccess.toolkit, set: values });
}

/** Back to the default: an app disconnected, then connected again, starts afresh. */
export async function clearAppAccess(db: TenantDb, toolkit: string): Promise<void> {
  await db.delete(appAccess).where(eq(appAccess.toolkit, toolkit));
}
