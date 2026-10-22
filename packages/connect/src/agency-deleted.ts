import type { SecretStore } from "@locus/secrets";
import { ghlSecretRef } from "./agency.ts";
import { vercelSecretRef } from "./vercel.ts";

/**
 * Removes every credential Locus sealed for an agency: its GHL grant and its Vercel token. The
 * agency's connection rows go with the agency (they cascade), but the sealed values live in
 * `secret` by path, with no foreign key, so they would outlive it. GitHub keeps none per agency:
 * the App's installation token is minted on demand from the App's own key.
 *
 * Run before the agency is deleted, so a failure stops the deletion instead of leaving tokens
 * no agency owns. Deleting a path that isn't there is not an error, so a retry is safe.
 */
export async function deleteAgencySecrets(
  secrets: Pick<SecretStore, "delete">,
  organizationId: string,
): Promise<void> {
  await secrets.delete(ghlSecretRef(organizationId));
  await secrets.delete(vercelSecretRef(organizationId));
}
