import { createAuth, emailFromEnv, type SessionContext } from "@locus/auth";
import { type ControlDb, DEV_CONTROL_DB_URL, openControlDb } from "@locus/db";
import * as schema from "@locus/db/control";
import { headers } from "next/headers";

/**
 * Thrown in production when a setting is missing or wrong. The message names the setting, never
 * its value, and is logged so the deployment's logs say which one; the visitor sees only that
 * something isn't set up.
 */
export class NotConfigured extends Error {
  constructor(what: string) {
    super(`Locus is not configured: ${what}`);
    this.name = "NotConfigured";
    console.error(this.message);
  }
}

const production = process.env.NODE_ENV === "production";

function setting(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (production) throw new NotConfigured(`${name} is not set`);
  return devDefault;
}

function build() {
  const db = openControlDb(
    setting("LOCUS_CONTROL_DB_URL", DEV_CONTROL_DB_URL),
    process.env.LOCUS_CONTROL_DB_TOKEN,
  );
  const auth = createAuth({
    db,
    schema,
    baseURL: setting("BETTER_AUTH_URL", "http://localhost:3000"),
    secret: setting("BETTER_AUTH_SECRET", "local-development-only-secret-not-for-production"),
    sendEmail: emailFromEnv(),
  });
  return { db, auth };
}

let instance: { db: ControlDb; auth: ReturnType<typeof createAuth> } | undefined;

/** The control database and Better Auth, created on first use. Server-side only. */
export function locus() {
  instance ??= build();
  return instance;
}

/** False in a deployment that has no control database or auth secret yet. */
export function configured(): boolean {
  try {
    locus();
    return true;
  } catch (error) {
    if (error instanceof NotConfigured) return false;
    throw error;
  }
}

/** The signed-in user's session, from the request's cookies — or null. */
export async function currentSession() {
  // Read the request first: it marks the page as dynamic, so it is never prerendered at build.
  const requestHeaders = await headers();
  if (!configured()) return null;
  return locus().auth.api.getSession({ headers: requestHeaders });
}

/** What the access checks read from a Better Auth session. */
export function sessionContext(
  current: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
): SessionContext {
  const { id, userId, activeOrganizationId, activeLocationId } = current.session;
  return { id, userId, activeOrganizationId, activeLocationId };
}
