"use server";

import { ClientAccessDenied, selectClient } from "@locus/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession, locus, sessionContext } from "@/lib/locus";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** Better Auth's API errors carry a readable message in `body.message`. */
function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const body = (error as { body?: { message?: unknown } }).body;
    if (typeof body?.message === "string") return body.message;
    if (error instanceof Error) return error.message;
  }
  return "Something went wrong.";
}

const back = (path: string, error: unknown): never =>
  redirect(`${path}?error=${encodeURIComponent(messageOf(error))}`);

export async function signUp(form: FormData) {
  try {
    await locus().auth.api.signUpEmail({
      body: {
        name: text(form, "name"),
        email: text(form, "email"),
        password: String(form.get("password") ?? ""),
        callbackURL: "/onboarding",
      },
    });
  } catch (error) {
    back("/sign-up", error);
  }
  redirect("/sign-up?sent=1");
}

export async function signIn(form: FormData) {
  try {
    await locus().auth.api.signInEmail({
      body: { email: text(form, "email"), password: String(form.get("password") ?? "") },
      headers: await headers(),
    });
  } catch (error) {
    back("/sign-in", error);
  }
  redirect("/");
}

export async function signOut() {
  await locus().auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "agency"}-${crypto.randomUUID().slice(0, 6)}`;
}

/** A new agency, owned by the signed-in user and made their active one. */
export async function createAgency(form: FormData) {
  const name = text(form, "name");
  try {
    const requestHeaders = await headers();
    const agency = await locus().auth.api.createOrganization({
      body: { name, slug: slugify(name) },
      headers: requestHeaders,
    });
    if (!agency) throw new Error("The agency could not be created.");
    await locus().auth.api.setActiveOrganization({
      body: { organizationId: agency.id },
      headers: requestHeaders,
    });
  } catch (error) {
    back("/onboarding", error);
  }
  redirect("/");
}

/**
 * Makes a client the session's active one. The only place a client id comes from the user —
 * `selectClient` checks the member may work on it before storing it on the session.
 */
export async function chooseClient(form: FormData) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  try {
    await selectClient(locus().db, sessionContext(current), text(form, "locationId"));
  } catch (error) {
    if (error instanceof ClientAccessDenied) back("/clients", error);
    throw error;
  }
  redirect("/");
}
