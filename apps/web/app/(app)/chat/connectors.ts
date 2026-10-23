"use server";

import { ClientAccessDenied } from "@locus/auth";
import { appConnectionsFromEnv, clientApps, clientDbFromEnv } from "@/lib/apps";
import { currentSession, locus, sessionContext } from "@/lib/locus";

/** A connected app, as the chat's + menu lists it. */
export type ChatConnector = { toolkit: string; name: string; logo: string; expired: boolean };

/**
 * The session's sub-account's connected apps, for the chat's + menu. The sub-account is the
 * session's, after the staff check; nothing here names one.
 */
export async function chatConnectors(): Promise<{ apps: ChatConnector[] } | { error: string }> {
  const current = await currentSession();
  if (!current) return { error: "You're signed out. Sign in again." };
  const connections = appConnectionsFromEnv();
  if (!connections) return { apps: [] };
  try {
    const { apps } = await clientApps(
      locus().db,
      sessionContext(current),
      connections,
      clientDbFromEnv(),
    );
    return {
      apps: apps
        .filter((app) => app.connected || app.expired)
        .map((app) => ({
          toolkit: app.toolkit,
          name: app.name,
          logo: app.logo,
          expired: !app.connected,
        })),
    };
  } catch (error) {
    if (error instanceof ClientAccessDenied) return { error: "You can't open this sub-account." };
    console.error("Chat connectors: listing failed", error);
    return { error: "Locus couldn't load your connectors just now." };
  }
}
