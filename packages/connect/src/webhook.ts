import { createPublicKey, verify } from "node:crypto";
import { agencyGhlConnection, location } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { type ConnectDeps, ghlSecretRef, suspendLocation, syncLocations } from "./agency.ts";

/**
 * GHL signs webhook bodies with Ed25519 and sends the signature, base64, in `X-GHL-Signature`
 * (the RSA `X-WH-Signature` scheme was retired on 2026-09-01). Verify against the exact bytes
 * received — parse the JSON only afterwards.
 *
 * `publicKey` is GHL's key as published in its webhook guide: base64 SPKI DER, or PEM.
 */
export function verifyGhlSignature(
  rawBody: string,
  signature: string | null | undefined,
  publicKey: string,
): boolean {
  if (!signature) return false;
  try {
    const key = publicKey.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(rawBody), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The fields Locus reads from GHL's app install/uninstall webhooks. */
export interface GhlAppWebhook {
  type?: string;
  appId?: string;
  companyId?: string;
  locationId?: string;
  companyName?: string;
  isWhitelabelCompany?: boolean;
  whitelabelDetails?: { domain?: string; logoUrl?: string };
}

export type WebhookOutcome =
  | "ignored"
  | "unknown-agency"
  | "synced"
  | "location-suspended"
  | "agency-uninstalled";

/**
 * Keeps the registry in step with installs in GHL, so a client added there appears in Locus
 * without anyone asking. Safe to receive twice: syncing is idempotent.
 *
 * - `INSTALL` for a connected agency → sync its sub-accounts (and record white-label branding).
 * - `UNINSTALL` of one sub-account → suspend it. Its database is kept; offboarding is deliberate.
 * - `UNINSTALL` of the whole agency → suspend all its sub-accounts and drop the revoked tokens.
 */
export async function handleGhlWebhook(
  deps: ConnectDeps,
  event: GhlAppWebhook,
): Promise<WebhookOutcome> {
  if (event.type !== "INSTALL" && event.type !== "UNINSTALL") return "ignored";
  if (event.appId && event.appId !== deps.ghl.appId) return "ignored";
  if (!event.companyId) return "ignored";

  const [connection] = await deps.db
    .select()
    .from(agencyGhlConnection)
    .where(eq(agencyGhlConnection.ghlCompanyId, event.companyId));
  // An install from an agency that hasn't connected through Locus yet: it gets its clients
  // when it does. Nothing to do here, and nothing to trust either.
  if (!connection) return "unknown-agency";
  const { organizationId } = connection;

  if (event.type === "INSTALL") {
    if (event.isWhitelabelCompany !== undefined || event.companyName) {
      await deps.db
        .update(agencyGhlConnection)
        .set({
          isWhitelabel: event.isWhitelabelCompany ?? connection.isWhitelabel,
          whitelabelDomain: event.whitelabelDetails?.domain ?? connection.whitelabelDomain,
          whitelabelLogoUrl: event.whitelabelDetails?.logoUrl ?? connection.whitelabelLogoUrl,
          companyName: event.companyName ?? connection.companyName,
        })
        .where(eq(agencyGhlConnection.organizationId, organizationId));
    }
    await syncLocations(deps, organizationId);
    return "synced";
  }

  if (event.locationId) {
    await suspendLocation(deps.db, organizationId, event.locationId);
    return "location-suspended";
  }
  await deps.db
    .update(location)
    .set({ status: "suspended" })
    .where(eq(location.organizationId, organizationId));
  await deps.secrets.delete(ghlSecretRef(organizationId));
  return "agency-uninstalled";
}
