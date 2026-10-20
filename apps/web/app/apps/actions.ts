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

const failed = (error: unknown): never => {
  const message =
    error instanceof ClientAccessDenied
      ? "Only owners and admins can connect or disconnect apps."
      : error instanceof AppServiceError
        ? error.message
        : "Composio couldn't do that just now. Try again.";
  if (!(error instanceof ClientAccessDenied || error instanceof AppServiceError)) {
    console.error("Apps page: Composio failed", error);
  }
  redirect(`/apps?error=${encodeURIComponent(message)}`);
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

export async function disconnectApp(form: FormData) {
  const { ctx, connections } = await signedIn();
  try {
    await disconnectClientApp(locus().db, ctx, connections, String(form.get("toolkit") ?? ""));
  } catch (error) {
    failed(error);
  }
  redirect("/apps?disconnected=1");
}
