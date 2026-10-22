import { type ControlDb, offboardLocation, type TenantProvisioner } from "@locus/db";
import { agencyGhlConnection, hostConnection, location } from "@locus/db/control";
import type { SecretStore } from "@locus/secrets";
import { eq } from "drizzle-orm";
import { ghlSecretRef } from "./agency.ts";
import { vercelSecretRef } from "./vercel.ts";

/**
 * Removes every credential Locus sealed for an agency: its GHL grant and its host token. The
 * agency's connection rows go with the agency (they cascade), but the sealed values live in
 * `secret` by path, with no foreign key, so they would outlive it. GitHub keeps none per agency:
 * the App's installation token is minted on demand from the App's own key.
 *
 * The paths come from the agency's connection rows while they exist, and the paths Locus saves
 * them at today always, so a row naming another path (a new host) is not missed and a run after
 * the rows are gone still finds the usual ones.
 *
 * Run it before the agency is deleted, so a failure stops the deletion instead of leaving tokens
 * no agency owns, and again after, for a token a renewal saved meanwhile. Deleting a path that
 * isn't there is not an error, so a retry is safe.
 */
export async function deleteAgencySecrets(
  deps: { db: ControlDb; secrets: Pick<SecretStore, "delete"> },
  organizationId: string,
): Promise<void> {
  const [ghl, host] = await Promise.all([
    deps.db
      .select({ secretRef: agencyGhlConnection.secretRef })
      .from(agencyGhlConnection)
      .where(eq(agencyGhlConnection.organizationId, organizationId)),
    deps.db
      .select({ secretRef: hostConnection.secretRef })
      .from(hostConnection)
      .where(eq(hostConnection.organizationId, organizationId)),
  ]);
  const paths = new Set([
    ghlSecretRef(organizationId),
    vercelSecretRef(organizationId),
    ...ghl.map((row) => row.secretRef),
    ...host.map((row) => row.secretRef),
  ]);
  for (const path of paths) await deps.secrets.delete(path);
}

/**
 * Removes what an agency's clients leave outside the control database: each client's connected
 * apps (its Composio user's accounts), its app-style sites' databases and its own database
 * (`offboardLocation`). A client's registry row goes too, so nothing names the client after.
 *
 * Run it before the agency is deleted: a failure stops the deletion and a retry picks up where it
 * stopped, since each client is removed only once its apps and databases are gone.
 */
export async function offboardAgencyClients(
  deps: {
    db: ControlDb;
    provisioner: TenantProvisioner;
    /** Removes every app the client connected; left out where connected apps aren't set up. */
    disconnectApps?: (clientId: string) => Promise<void>;
  },
  organizationId: string,
): Promise<void> {
  const clients = await deps.db
    .select({ id: location.id })
    .from(location)
    .where(eq(location.organizationId, organizationId));
  for (const client of clients) {
    await deps.disconnectApps?.(client.id);
    await offboardLocation({ control: deps.db, provisioner: deps.provisioner }, client.id);
  }
}
