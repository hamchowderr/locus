"use server";

import { ClientAccessDenied } from "@locus/auth";
import { redirect } from "next/navigation";
import {
  AppAccessInputError,
  AppServiceError,
  appConnectionsFromEnv,
  clientDbFromEnv,
  connectClientApp,
  disconnectClientApp,
  setClientAppAccess,
} from "@/lib/apps";
import { baseUrl } from "@/lib/connect";
import { currentSession, locus, sessionContext } from "@/lib/locus";

function message(error: unknown): string {
  if (error instanceof ClientAccessDenied) {
    return "Only owners and admins can connect or disconnect apps, or change how the chat uses them.";
  }
  if (error instanceof AppServiceError || error instanceof AppAccessInputError) {
    return error.message;
  }
  console.error("Apps page: Composio failed", error);
  return "Composio couldn't do that just now. Try again.";
}

const failed = (error: unknown): never => {
  redirect(`/apps?error=${encodeURIComponent(message(error))}`);
};

async function signedIn() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fapps");
  const connections = appConnectionsFromEnv();
  if (!connections) redirect("/apps");
  return { ctx: sessionContext(current), connections };
}

/** Sends the person to the app's own sign-in page; it brings them back here. */
export async function connectApp(form: FormData) {
  const { ctx, connections } = await signedIn();
  const toolkit = String(form.get("toolkit") ?? "");
  let url: string;
  try {
    url = await connectClientApp(
      locus().db,
      ctx,
      connections,
      toolkit,
      `${baseUrl()}/apps?connected=${encodeURIComponent(toolkit)}`,
    );
  } catch (error) {
    failed(error);
    return;
  }
  redirect(url);
}

/**
 * The app's sign-in link, for the Connect button to open in a pop-up. It comes back to
 * /apps/connected, which tells this page and closes itself.
 */
export async function connectAppLink(
  toolkit: string,
): Promise<{ url: string } | { error: string }> {
  // Called from the chat too, so it answers with an error instead of redirecting that page.
  const current = await currentSession();
  if (!current) return { error: "You're signed out. Sign in again, then connect the app." };
  const connections = appConnectionsFromEnv();
  if (!connections) return { error: "Connected apps aren't set up here yet." };
  const ctx = sessionContext(current);
  try {
    const url = await connectClientApp(
      locus().db,
      ctx,
      connections,
      toolkit,
      `${baseUrl()}/apps/connected?toolkit=${encodeURIComponent(toolkit)}`,
    );
    return { url };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function disconnectApp(form: FormData) {
  const { ctx, connections } = await signedIn();
  try {
    await disconnectClientApp(
      locus().db,
      ctx,
      connections,
      clientDbFromEnv(),
      String(form.get("toolkit") ?? ""),
    );
  } catch (error) {
    failed(error);
  }
  redirect("/apps?disconnected=1");
}

/**
 * How the chat may use one connected app, from the app's settings menu. The client is the
 * session's; only the app and the setting come from the page.
 */
export async function setAppAccess(
  toolkit: string,
  access: string,
): Promise<{ ok: true } | { error: string }> {
  const current = await currentSession();
  if (!current) return { error: "You're signed out. Sign in again, then change the setting." };
  try {
    await setClientAppAccess(
      locus().db,
      sessionContext(current),
      clientDbFromEnv(),
      String(toolkit),
      String(access),
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof ClientAccessDenied || error instanceof AppAccessInputError) {
      return { error: message(error) };
    }
    console.error("Apps page: saving a setting failed", error);
    return { error: "Locus couldn't save that just now. Try again." };
  }
}
