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
}

/** Whom it told; `unknown client` for a client this deployment doesn't have. */
export type ExpiredAppOutcome = { told: number } | "unknown client";

export async function tellExpiredApp(
  deps: ExpiredAppDeps,
  event: { clientId: string; toolkit: string },
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
  for (const address of to) await deps.sendEmail({ to: address, subject, text });
  return { told: to.length };
}
