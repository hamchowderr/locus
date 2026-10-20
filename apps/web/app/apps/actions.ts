"use server";

import { ClientAccessDenied } from "@locus/auth";
import { redirect } from "next/navigation";
import {
  AppServiceError,
  appConnectionsFromEnv,
  connectClientApp,
  disconnectClientApp,
} from "@/lib/apps";
import { baseUrl } from "@/lib/connect";
import { currentSession, locus, sessionContext } from "@/lib/locus";

function message(error: unknown): string {
  if (error instanceof ClientAccessDenied) {
    return "Only owners and admins can connect or disconnect apps.";
  }
  if (error instanceof AppServiceError) return error.message;
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
  const { ctx, connections } = await signedIn();
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
    await disconnectClientApp(locus().db, ctx, connections, String(form.get("toolkit") ?? ""));
  } catch (error) {
    failed(error);
  }
  redirect("/apps?disconnected=1");
}
