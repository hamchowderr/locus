/**
 * A scripted stand-in for the model, for staging: AIMock answers every message with a fixed
 * reply, in-process, so the chat works end to end without an AI provider's key or cost.
 */

import { LLMock } from "@copilotkit/aimock";
import type { MastraModelConfig } from "@mastra/core/llm";

/** The `LOCUS_AGENT_MODEL` value that selects the scripted model. */
export const SCRIPTED = "scripted";

export const SCRIPTED_REPLY =
  "This is Locus's scripted test assistant. No AI model is connected, so every message gets this reply.";

/**
 * In the site builder's mode, this message runs `node --version` in the chosen site's sandbox,
 * so staging can check the whole sandbox path (agent, web app, Vercel Sandbox) at no AI cost.
 */
export const SANDBOX_CHECK = "sandbox check";
export const SANDBOX_CHECK_REPLY = "Sandbox check finished: the command's output is above.";

/** Starts the scripted model on a local port and returns its model config. */
export async function scriptedModel(): Promise<MastraModelConfig> {
  const mock = new LLMock({ host: "127.0.0.1", port: 0, journalMaxEntries: 50 });
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
  mock.onMessage(/^/, { content: SCRIPTED_REPLY });
  await mock.start();
  return { id: "anthropic/locus-scripted", url: `${mock.url}/v1`, apiKey: SCRIPTED };
}
