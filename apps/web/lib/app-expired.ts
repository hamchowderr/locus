/**
 * When a client's app sign-in expires (Composio tells Locus by webhook), the agency's owners
 * and admins get an email naming the client and the app, with the way back to reconnect it.
 * Other members aren't told: only owners and admins can connect apps.
 */

import { rolesOf, type SendEmail } from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { location, member, organization, user } from "@locus/db/control";
import { and, eq } from "drizzle-orm";

export interface ExpiredAppDeps {
  db: ControlDb;
  sendEmail: SendEmail;
  /** Where Locus is, for the link back: `https://locus.otakusolutions.io`. */
  baseUrl: string;
  /** The app's name as the Connectors page shows it; its slug without one. */
  appName?: (toolkit: string) => Promise<string | undefined>;
  /** Whether the client has the app connected again (a late or repeated delivery). */
  reconnected?: (clientId: string, toolkit: string) => Promise<boolean>;
}

/**
 * Whom it told; `unknown client` for a client this deployment doesn't have, `reconnected` when
 * someone has signed in again since.
 */
export type ExpiredAppOutcome = { told: number } | "unknown client" | "reconnected";

/**
 * Composio delivers at least once, so each email carries a key made of the delivery's id and
 * the address: a retry, after one email of several failed, sends only the ones still owed.
 */
export async function tellExpiredApp(
  deps: ExpiredAppDeps,
  event: { deliveryId: string; clientId: string; toolkit: string },
): Promise<ExpiredAppOutcome> {
  const [client] = await deps.db
    .select({
      name: location.name,
      agency: organization.name,
      organizationId: location.organizationId,
    })
    .from(location)
    .innerJoin(organization, eq(organization.id, location.organizationId))
    .where(and(eq(location.id, event.clientId), eq(location.status, "active")));
  if (!client) return "unknown client";
  if (await deps.reconnected?.(event.clientId, event.toolkit)) return "reconnected";
  const managers = await deps.db
    .select({ email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, client.organizationId));
  const to = [
    ...new Set(
      managers
        .filter((m) => rolesOf(m.role).some((r) => r === "owner" || r === "admin"))
        .map((m) => m.email),
    ),
  ];
  const app = (await deps.appName?.(event.toolkit).catch(() => undefined)) ?? event.toolkit;
  const subject = `${app} needs signing in again for ${client.name}`;
  const text = [
    `The ${app} sign-in for ${client.name} (${client.agency}) has expired, so the chat can't use ${app} for this client until someone signs in again.`,
    "",
    `To fix it, open Locus, pick ${client.name}, go to Connectors and press Reconnect on ${app}:`,
    `${deps.baseUrl}/apps`,
  ].join("\n");
  const sent = await Promise.allSettled(
    to.map((address) =>
      deps.sendEmail({
        to: address,
        subject,
        text,
        idempotencyKey: `app-expired/${event.deliveryId}/${address}`,
      }),
    ),
  );
  const failed = sent.filter((r) => r.status === "rejected");
  // Thrown, the delivery is answered with an error and Composio sends it again.
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${to.length} expired-app emails failed`, {
      cause: failed[0]?.reason,
    });
  }
  return { told: to.length };
}
