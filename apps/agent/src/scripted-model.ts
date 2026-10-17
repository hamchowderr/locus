/**
 * A scripted stand-in for the model, for staging: AIMock answers every message with a fixed
 * reply, in-process, so the chat works end to end without an AI provider's key or cost. Chats
 * recorded from a real model (`pnpm --filter @locus/agent record:chats`) replay first.
 */

import { LLMock } from "@copilotkit/aimock";
import type { MastraModelConfig } from "@mastra/core/llm";
import { loadRecordedChats, RECORDED_DIR } from "./recorded-fixtures.ts";

/** The `LOCUS_AGENT_MODEL` value that selects the scripted model. */
export const SCRIPTED = "scripted";

export const SCRIPTED_REPLY =
  "This is Locus's scripted test assistant. No AI model is connected, so every message gets this reply.";

/**
 * In the site builder's mode, this message runs `node --version` in the chosen site's sandbox,
 * so staging can check the whole sandbox path (agent, web app, Vercel Sandbox) at no AI cost.
 */
export const SANDBOX_CHECK = "sandbox check";
export const SANDBOX_CHECK_REPLY = "Sandbox check done: see the tool result above.";

/**
 * Three messages that let a person try each kind of tool call on staging without an AI model:
 * a read that runs unasked, a question that reaches them straight away, and a deletion that
 * waits for their approval. The deletion names a tag that cannot exist, so approving it only
 * gets GoHighLevel's "not found" back.
 */
export const SHOW_TAGS = "show my tags";
export const SHOW_TAGS_REPLY = "Those are this sub-account's tags: see the tool result above.";
export const ASK_ME = "ask me something";
export const ASK_ME_REPLY = "Thanks, I got your answer: see it above.";
export const DELETE_TAG = "delete a tag";
export const DELETE_TAG_REPLY =
  "The delete test is finished: the tool result above shows what happened.";
export const MISSING_TAG_ID = "locus-test-tag-that-does-not-exist";

export interface ScriptedOptions {
  /** Where recorded chats are replayed from; `fixtures/recorded/` by default. */
  recordedDir?: string;
  /**
   * Leave out the scripted test messages and the fixed reply, so any message no recorded chat
   * answers fails (AIMock's strict mode) instead of getting the fixed reply. For tests.
   */
  strict?: boolean;
}

/** Starts the scripted model on a local port and returns its model config. */
export async function scriptedModel(): Promise<MastraModelConfig> {
  return (await startScriptedModel()).model;
}

/** Starts the scripted model, and returns the mock too, so a test can read its journal. */
export async function startScriptedModel(
  options: ScriptedOptions = {},
): Promise<{ mock: LLMock; model: MastraModelConfig }> {
  const mock = new LLMock({
    host: "127.0.0.1",
    port: 0,
    journalMaxEntries: options.strict ? 0 : 50,
    strict: options.strict ?? false,
  });
  for (const chat of loadRecordedChats(options.recordedDir ?? RECORDED_DIR)) {
    mock.addFixtures(chat.fixtures);
  }
  if (!options.strict) scriptTestMessages(mock);
  await mock.start();
  return {
    mock,
    model: { id: "anthropic/locus-scripted", url: `${mock.url}/v1`, apiKey: SCRIPTED },
  };
}

function scriptTestMessages(mock: LLMock) {
  mock.on(
    { userMessage: new RegExp(`^\\s*${SANDBOX_CHECK}\\s*$`, "i"), hasToolResult: false },
    {
      toolCalls: [
        {
          id: "scripted-sandbox-check",
          name: "run_command",
          arguments: JSON.stringify({ command: "node", args: ["--version"] }),
        },
      ],
    },
  );
  mock.on({ toolCallId: "scripted-sandbox-check" }, { content: SANDBOX_CHECK_REPLY });
  script(mock, SHOW_TAGS, SHOW_TAGS_REPLY, "query_data", {
    sources: [{ as: "tags", operation: "locations.get-location-tags" }],
    sql: "select name from tags order by name limit 20",
  });
  script(mock, ASK_ME, ASK_ME_REPLY, "ask_user", {
    question: "Which colour do you like best?",
    options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
  });
  script(mock, DELETE_TAG, DELETE_TAG_REPLY, "perform_action", {
    operation: "locations.delete-tag",
    params: { path: { tagId: MISSING_TAG_ID } },
  });
  mock.onMessage(/^/, { content: SCRIPTED_REPLY });
}

/** Answers `message` with one call of `tool`, then answers that call's result with `reply`. */
function script(mock: LLMock, message: string, reply: string, tool: string, args: object) {
  const id = `scripted-${message.replaceAll(" ", "-")}`;
  mock.on(
    { userMessage: new RegExp(`^\\s*${message}\\s*$`, "i"), hasToolResult: false },
    { toolCalls: [{ id, name: tool, arguments: JSON.stringify(args) }] },
  );
  mock.on({ toolCallId: id }, { content: reply });
}
