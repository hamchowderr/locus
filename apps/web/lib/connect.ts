import { randomBytes } from "node:crypto";
import { type AuthorizedClient, agencyEntitlement, newClientRefusal } from "@locus/auth";
import {
  type ConnectDeps,
  ConnectError,
  checkClientGhl,
  createStubGhl,
  GHL_SCOPES,
  type GhlAppConfig,
  STUB_CODE,
  syncLocations,
} from "@locus/connect";
import { DbSecretStore, provisionerFromEnv } from "@locus/db";
import { agencyGhlConnection } from "@locus/db/control";
import { GhlError } from "@locus/ghl";
import { deriveSecretsSubkey, secretsFromEnv } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { deploymentBaseUrl } from "./base-url.ts";
import { billingEnabled, locus, NotConfigured } from "./locus.ts";

const production = process.env.NODE_ENV === "production";

/** `<NAME>=stub` (the default outside production) plays a pretend account; `live` is real. */
export function serviceMode(variable: "GHL_MODE" | "GITHUB_MODE" | "VERCEL_MODE"): "stub" | "live" {
  const mode = process.env[variable] ?? (production ? "live" : "stub");
  if (mode === "stub" && production) throw new NotConfigured(`${variable}=stub in production`);
  if (mode !== "stub" && mode !== "live") throw new NotConfigured(`${variable}=${mode}`);
  return mode;
}

/** `GHL_MODE=stub` plays a pretend agency with three sub-accounts. */
export const ghlMode = () => serviceMode("GHL_MODE");

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new NotConfigured(`${name} is not set`);
  return value;
}

export function baseUrl(): string {
  return deploymentBaseUrl() ?? "http://localhost:3000";
}

function appConfig(): GhlAppConfig {
  const redirectUri = `${baseUrl()}/api/connect/crm/callback`;
  if (ghlMode() === "stub") {
    return {
      clientId: "stub-client",
      clientSecret: "stub-secret",
      appId: "stub-app",
      redirectUri,
      scopes: ["locations.readonly", "oauth.readonly", "oauth.write"],
    };
  }
  return {
    clientId: required("GHL_CLIENT_ID"),
    clientSecret: required("GHL_CLIENT_SECRET"),
    appId: required("GHL_APP_ID"),
    redirectUri,
    scopes: GHL_SCOPES,
  };
}

let stubFetch: typeof fetch | undefined;

/** Building these fails only on configuration (a mode, a missing key or token): a 503. */
export function configured<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new NotConfigured((error as Error).message);
  }
}

/** Agencies' credentials: sealed in the control database in production. */
export function secretStore(db: ReturnType<typeof locus>["db"]) {
  return configured(() =>
    secretsFromEnv({
      localFile: ".data/secrets.json",
      encrypted: (cipher) => new DbSecretStore(db, cipher),
    }),
  );
}

let devIpKey: Buffer | undefined;

/**
 * The key site leads' visitor IPs are hashed with: derived from `LOCUS_SECRETS_KEY` (HKDF, label
 * "locus/site-lead-ip"). Without that key outside production, a random one for this process.
 * Server-side only; never logged.
 */
export function siteLeadIpKey(): Buffer {
  if (process.env.LOCUS_SECRETS_KEY || production) {
    return configured(() => deriveSecretsSubkey("locus/site-lead-ip"));
  }
  devIpKey ??= randomBytes(32);
  return devIpKey;
}

let warnedTestPayments = false;

/**
 * Whether invoices a site's checkout makes take real money: only with
 * `LOCUS_GHL_LIVE_PAYMENTS=true`. Anything else makes GHL test-mode invoices. Against live GHL
 * with the setting left out, that is probably a mistake, so it says so in the log, once.
 */
export function ghlLivePayments(): boolean {
  const setting = process.env.LOCUS_GHL_LIVE_PAYMENTS;
  if (setting === undefined && !warnedTestPayments && ghlMode() === "live") {
    warnedTestPayments = true;
    console.warn(
      "LOCUS_GHL_LIVE_PAYMENTS is not set: site checkouts make GHL test-mode invoices, which " +
        "take no money. Set it to true for real payments, or false to keep test mode.",
    );
  }
  return setting === "true";
}

/** Everything the connect flow needs, from the environment. Server-side only. */
export function connectDeps(): ConnectDeps {
  const mode = ghlMode();
  stubFetch ??= createStubGhl();
  const { db } = locus();
  return {
    db,
    secrets: secretStore(db),
    provisioner: configured(() => provisionerFromEnv(".data/tenants")),
    ghl: appConfig(),
    ...(billingEnabled()
      ? {
          newClientRefusal: async (organizationId: string, activeClients: number) =>
            newClientRefusal(await agencyEntitlement(db, organizationId), activeClients),
        }
      : {}),
    ...(mode === "stub" ? { http: { fetch: stubFetch, baseUrl: "https://stub.ghl.local" } } : {}),
  };
}

/**
 * Adds the sub-accounts that were waiting for a plan, once the agency may have them: after a
 * payment or when a trial starts. Nothing to do for an agency that hasn't connected GoHighLevel.
 */
export async function addWaitingClients(organizationId: string): Promise<void> {
  const [connection] = await locus()
    .db.select({ organizationId: agencyGhlConnection.organizationId })
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.organizationId, organizationId));
  if (!connection) return;
  await syncLocations(connectDeps(), organizationId);
}

/** In stub mode the "GHL approval page" is a local route that approves straight away. */
export function stubAuthorizeTarget(state: string): string {
  const callback = new URL("/api/connect/crm/callback", baseUrl());
  callback.searchParams.set("code", STUB_CODE);
  callback.searchParams.set("state", state);
  return callback.toString();
}

export const STATE_COOKIE = "locus_crm_state";

/** Holds the id of a marketplace install's grant while its installer signs in and confirms. */
export const HELD_GRANT_COOKIE = "locus_ghl_install";

export type GhlCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Whether Locus can act inside the client right now. Read-only; nothing is kept. */
export async function checkClientConnection(client: AuthorizedClient): Promise<GhlCheck> {
  try {
    return { ok: true, ...(await checkClientGhl(connectDeps(), client)) };
  } catch (error) {
    if (error instanceof NotConfigured) {
      return { ok: false, reason: "GoHighLevel isn't set up on this deployment yet." };
    }
    if (error instanceof ConnectError) return { ok: false, reason: error.message };
    if (error instanceof GhlError) {
      console.error(`Client GoHighLevel check failed: ${error.message}`);
      return { ok: false, reason: `GoHighLevel refused (${error.status}).` };
    }
    throw error;
  }
}

// GHL refuses redirect and webhook URLs that mention HighLevel ("The redirect url contains a
// Highlevel reference"), so the routes that GHL calls are named `crm`, never `ghl`.
