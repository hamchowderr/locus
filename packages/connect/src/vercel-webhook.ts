import { createHmac, timingSafeEqual } from "node:crypto";
import { hostConnection } from "@locus/db/control";
import { and, eq } from "drizzle-orm";
import type { VercelConnectDeps, VercelGrant } from "./vercel.ts";

// Contract read from vercel.com/docs/webhooks/webhooks-api on 2026-10-22: integration webhooks
// are signed in `x-vercel-signature` with the hex HMAC-SHA1 of the raw body, keyed with the
// integration's client secret; `integration-configuration.removed` carries
// `payload.configuration.id` and `payload.team.id` (null for a personal account) and
// `payload.user.id`.

/** Checks Vercel's signature against the exact bytes received, before anything is parsed. */
export function verifyVercelSignature(
  rawBody: string,
  signature: string | null | undefined,
  clientSecret: string,
): boolean {
  if (!signature || !clientSecret) return false;
  const expected = Buffer.from(
    createHmac("sha1", clientSecret).update(rawBody, "utf8").digest("hex"),
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The fields Locus reads from the integration's webhooks. */
export interface VercelWebhook {
  type?: string;
  payload?: {
    configuration?: { id?: string };
    team?: { id?: string | null } | null;
    user?: { id?: string };
  };
}

/**
 * When an agency removes the Locus integration on Vercel's side, its token stops working: the
 * agency's Vercel connection goes and its sealed token with it, so Locus asks it to connect
 * again instead of failing on each publish. Only the connection made by that installation
 * goes: one an agency made again since, with a new installation, stays. Safe to receive twice.
 */
export async function handleVercelWebhook(
  deps: Pick<VercelConnectDeps, "db" | "secrets">,
  event: VercelWebhook,
): Promise<"disconnected" | "ignored"> {
  // The dotted name, and the hyphenated one older integrations still receive.
  if (
    event.type !== "integration-configuration.removed" &&
    event.type !== "integration-configuration-removed"
  ) {
    return "ignored";
  }
  const configurationId = event.payload?.configuration?.id;
  const scope = event.payload?.team?.id ?? event.payload?.user?.id;
  if (!configurationId || !scope) return "ignored";

  const rows = await deps.db
    .select()
    .from(hostConnection)
    .where(and(eq(hostConnection.provider, "vercel"), eq(hostConnection.teamId, scope)));
  let removed = 0;
  for (const row of rows) {
    // A token that's already gone, or can't be read, was this installation's too.
    let grant: Partial<VercelGrant> | undefined;
    try {
      const sealed = await deps.secrets.get(row.secretRef);
      grant = sealed ? (JSON.parse(sealed) as Partial<VercelGrant>) : undefined;
    } catch {
      // Not the error itself: a parse error can quote the token.
      console.error("Couldn't read a sealed Vercel grant; removing its connection.");
    }
    if (grant && grant.configurationId !== configurationId) continue;
    // Matching connectedAt keeps a connection the agency made again meanwhile.
    const deleted = await deps.db
      .delete(hostConnection)
      .where(
        and(
          eq(hostConnection.organizationId, row.organizationId),
          eq(hostConnection.secretRef, row.secretRef),
          eq(hostConnection.connectedAt, row.connectedAt),
        ),
      )
      .returning({ secretRef: hostConnection.secretRef });
    if (deleted.length === 0) continue;
    await deps.secrets.delete(row.secretRef);
    removed++;
  }
  return removed > 0 ? "disconnected" : "ignored";
}
