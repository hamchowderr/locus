/**
 * Recorded chats, ready to replay. `scripts/record-chats.ts` records each sample chat against a
 * real model into its own directory under `fixtures/recorded/`, one AIMock fixture file per
 * model call, in AIMock's own format. AIMock matches a recorded call on the last user message,
 * the model's name, the number of assistant messages so far and whether a tool result follows
 * the user's message — never on the tool result's content. This module rewrites those matches
 * so a chat replays against any data and in any thread:
 *
 * - the model's name is dropped: the scripted model is not the model that was recorded;
 * - the user's message must match exactly, not as a substring of a longer message;
 * - a call that follows a tool result matches on that tool call's id instead of on its
 *   position, since the replayed tool calls carry the recorded ids. Position (the number of
 *   assistant messages) depends on the thread's history, so a multi-step chat replayed in a
 *   thread that already has messages would otherwise skip steps.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Fixture, type FixtureMatch, loadFixtureFile } from "@copilotkit/aimock";

/** Where `record:chats` writes, and where the scripted model replays from. */
export const RECORDED_DIR = fileURLToPath(new URL("../fixtures/recorded/", import.meta.url));

/** Every recorded chat under `dir`: its directory name and its fixtures, ready to replay. */
export function loadRecordedChats(
  dir: string = RECORDED_DIR,
): { id: string; fixtures: Fixture[] }[] {
  return listDir(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .map((id) => ({ id, fixtures: loadRecordedChat(join(dir, id)) }))
    .filter((chat) => chat.fixtures.length > 0);
}

/** One chat's fixture files, in the order they were recorded, rewritten for replay. */
export function loadRecordedChat(dir: string): Fixture[] {
  // The recorder names each file `<provider>-<ISO time>-<random>.json`, so name order is
  // recording order.
  const files = listDir(dir).filter((name) => name.endsWith(".json"));
  return forReplay(files.flatMap((name) => loadFixtureFile(join(dir, name))));
}

/** Rewrites one chat's recorded matches, in recording order (see the module comment). */
export function forReplay(recorded: Fixture[]): Fixture[] {
  // The last tool call each user message's latest model call made.
  const lastCall = new Map<string, string>();
  return recorded.map((fixture) => {
    const { model: _model, ...match } = fixture.match;
    const text = typeof match.userMessage === "string" ? match.userMessage : undefined;
    let replay: FixtureMatch = match;
    const previous = text === undefined ? undefined : lastCall.get(text);
    if (match.hasToolResult === true && previous !== undefined) {
      replay = { toolCallId: previous };
    } else if (text !== undefined) {
      replay = { ...match, userMessage: exactly(text) };
    }
    if (text !== undefined) {
      const id = lastToolCallId(fixture.response);
      if (id === undefined) lastCall.delete(text);
      else lastCall.set(text, id);
    }
    return { ...fixture, match: replay };
  });
}

function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function lastToolCallId(response: Fixture["response"]): string | undefined {
  if (typeof response !== "object" || response === null || !("toolCalls" in response)) {
    return undefined;
  }
  const calls = (response as { toolCalls?: { id?: string }[] }).toolCalls;
  return calls?.at(-1)?.id;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
