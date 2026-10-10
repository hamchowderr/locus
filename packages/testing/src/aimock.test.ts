import { expect, test } from "vitest";
import { useAimock } from "./index.ts";

const mock = useAimock();

// Proves the wiring every level-1 skill test relies on: a fixture decides what the "model"
// does — here, load a skill — so the code under test can be checked deterministically.
test("a fixture makes the model call a tool", async () => {
  mock().llm.on(
    { userMessage: /chase last week's leads/ },
    { toolCalls: [{ name: "load_skill", arguments: '{"domain":"opportunities"}' }] },
  );

  const res = await fetch(`${mock().url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "chase last week's leads" }],
    }),
  });
  const message = (await res.json()) as {
    content: { type: string; name?: string; input?: unknown }[];
  };

  const toolUse = message.content.find((block) => block.type === "tool_use");
  expect(toolUse).toMatchObject({ name: "load_skill", input: { domain: "opportunities" } });
});
