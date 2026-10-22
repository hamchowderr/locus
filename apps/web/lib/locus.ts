import { createAuth, emailFromEnv, type SessionContext } from "@locus/auth";
import { type ControlDb, DEV_CONTROL_DB_URL, openControlDb, provisionerFromEnv } from "@locus/db";
import * as schema from "@locus/db/control";
import { headers } from "next/headers";
import { cache } from "react";
import { deploymentBaseUrl } from "./base-url.ts";

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

/** Billing is on when the deployment has a Stripe key. */
export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY;

function billingFromEnv() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return undefined;
  // Without the webhook secret checkout still works but no payment is ever recorded: say so in
  // the logs rather than taking the whole app down.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) new NotConfigured("STRIPE_WEBHOOK_SECRET is not set");
  return { secretKey, webhookSecret };
}

function build() {
  const db = openControlDb(
    setting("LOCUS_CONTROL_DB_URL", DEV_CONTROL_DB_URL),
    process.env.LOCUS_CONTROL_DB_TOKEN,
  );
  const auth = createAuth({
    db,
    schema,
    baseURL: deploymentBaseUrl() ?? setting("BETTER_AUTH_URL", "http://localhost:3000"),
    secret: setting("BETTER_AUTH_SECRET", "local-development-only-secret-not-for-production"),
    sendEmail: emailFromEnv(),
    billing: billingFromEnv(),
    // An agency's sealed tokens have no foreign key to it, so they go first, and once more after
    // for one a renewal saved meanwhile. The agency is gone by then, so a failure there is logged
    // rather than reported as a failed deletion. Its clients' databases and connected apps live
    // outside the control database, so they go before it too.
    beforeAgencyDeleted: async (organizationId) => {
      await removeAgencySecrets(db, organizationId);
      await offboardClients(db, organizationId);
    },
    afterAgencyDeleted: (organizationId) =>
      removeAgencySecrets(db, organizationId).catch((error: unknown) => {
        console.error("Removing a deleted agency's credentials failed", error);
      }),
  });
  return { db, auth };
}

// Loaded on use: `./connect` imports this module.
async function removeAgencySecrets(db: ControlDb, organizationId: string): Promise<void> {
  const [{ deleteAgencySecrets }, { secretStore }] = await Promise.all([
    import("@locus/connect"),
    import("./connect"),
  ]);
  await deleteAgencySecrets({ db, secrets: secretStore(db) }, organizationId);
}

async function offboardClients(db: ControlDb, organizationId: string): Promise<void> {
  const [{ offboardAgencyClients }, { configured }, { appConnectionsFromEnv }] = await Promise.all([
    import("@locus/connect"),
    import("./connect"),
    import("./apps"),
  ]);
  const apps = appConnectionsFromEnv();
  await offboardAgencyClients(
    {
      db,
      provisioner: configured(() => provisionerFromEnv(".data/tenants")),
      ...(apps ? { disconnectApps: (clientId: string) => apps.disconnectAll(clientId) } : {}),
    },
    organizationId,
  );
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

/**
 * The signed-in user's session, from the request's cookies — or null. Cached per request: the
 * menu's layout and the page both ask, and it is one lookup.
 */
export const currentSession = cache(async () => {
  // Read the request first: it marks the page as dynamic, so it is never prerendered at build.
  const requestHeaders = await headers();
  if (!configured()) return null;
  return locus().auth.api.getSession({ headers: requestHeaders });
});

/** What the access checks read from a Better Auth session. */
export function sessionContext(
  current: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
): SessionContext {
  const { id, userId, activeOrganizationId, activeLocationId } = current.session;
  return { id, userId, activeOrganizationId, activeLocationId };
}
