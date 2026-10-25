"use server";

import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  BrainInputError,
  brainDeps,
  createBrainNote,
  deleteBrainNote,
  restoreBrainNote,
  saveBrainNote,
} from "@/lib/brain";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

const notePage = (path: string) => `/brain?note=${encodeURIComponent(path)}`;

/** A refusal the person can act on, as text; anything else is a bug and is thrown. */
function refusal(error: unknown): string | null {
  if (error instanceof BrainInputError) return error.message;
  if (error instanceof ClientAccessDenied) return "You don't have access to this sub-account.";
  if (error instanceof NotConfigured) return "Client databases aren't set up here yet.";
  return null;
}

/**
 * Runs one change to the active client's brain as the signed-in person, then shows the note.
 * The client is the session's, never the form's.
 */
async function brainAction(
  form: FormData,
  change: (input: {
    client: Awaited<ReturnType<typeof resolveActiveClient>>;
    userId: string;
  }) => Promise<{ path: string; done: string }>,
) {
  const back = text(form, "path") ? notePage(text(form, "path")) : "/brain";
  let landing: string;
  try {
    const current = await currentSession();
    if (!current) redirect(`/sign-in?next=${encodeURIComponent(back)}`);
    const ctx = sessionContext(current);
    const client = await resolveActiveClient(locus().db, ctx);
    const { path, done } = await change({ client, userId: ctx.userId });
    landing = `${notePage(path)}&${done}`;
  } catch (error) {
    const message = refusal(error);
    if (message) {
      redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
    }
    throw error;
  }
  revalidatePath("/brain");
  revalidatePath("/chat");
  redirect(landing);
}

/** Saves an edited note. */
export async function saveNote(form: FormData) {
  await brainAction(form, async ({ client, userId }) => ({
    path: await saveBrainNote(
      brainDeps(),
      client,
      userId,
      text(form, "path"),
      text(form, "content"),
    ),
    done: "saved=1",
  }));
}

/** Starts a note from a folder and a name; refuses one that already exists. */
export async function createNote(form: FormData) {
  await brainAction(form, async ({ client, userId }) => ({
    path: await createBrainNote(
      brainDeps(),
      client,
      userId,
      text(form, "folder"),
      text(form, "name"),
    ),
    done: "created=1",
  }));
}

/** Deletes a note, after the person ticked the box. Its history keeps it. */
export async function deleteNote(form: FormData) {
  await brainAction(form, async ({ client, userId }) => {
    if (text(form, "confirm") !== "yes") {
      throw new BrainInputError("Tick the box to confirm you want the note deleted.");
    }
    await deleteBrainNote(brainDeps(), client, userId, text(form, "path"));
    return { path: text(form, "path"), done: "deleted=1" };
  });
}

/** Puts a note back as it was at one of its versions. */
export async function restoreNote(form: FormData) {
  await brainAction(form, async ({ client, userId }) => {
    await restoreBrainNote(
      brainDeps(),
      client,
      userId,
      text(form, "path"),
      Number(text(form, "version")),
    );
    return { path: text(form, "path"), done: "restored=1" };
  });
}
