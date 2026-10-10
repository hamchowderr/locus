import { createFakeGhl, useAimock } from "@locus/testing";
import { expect, test } from "vitest";
import { createLocusAgent } from "./agent.ts";

const mock = useAimock();

// Level-1 end to end: AIMock decides what the model does at each turn, so this proves the
// wiring — Mastra calls our tools, the tools reach GHL through the session, and the result
// flows back to the model — not the model's judgement.
test("the agent loads a skill, queries GHL and answers from the SQL result", async () => {
  mock().llm.on(
    { userMessage: /how many forms/i, hasToolResult: false },
    {
      toolCalls: [{ id: "call_skill", name: "load_skill", arguments: '{"category":"forms"}' }],
    },
  );
  mock().llm.on(
    { toolCallId: "call_skill" },
    {
      toolCalls: [
        {
          id: "call_query",
          name: "query_data",
          arguments: JSON.stringify({
            sources: [{ as: "forms", operation: "forms.get-forms" }],
            sql: "SELECT COUNT(*) AS n FROM forms",
          }),
        },
      ],
    },
  );
  mock().llm.on({ toolCallId: "call_query" }, { content: "You have 3 forms." });

  const ghl = createFakeGhl({
    "GET /forms/": { body: { forms: [{ id: "f1" }, { id: "f2" }, { id: "f3" }], total: 3 } },
  });
  const agent = createLocusAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    session: { token: "tok", tokenKind: "location", locationId: "loc-A" },
    fetch: ghl.fetch,
  });

  const result = await agent.generate("How many forms does this client have?", { maxSteps: 5 });

  expect(result.text).toBe("You have 3 forms.");
  expect(ghl.requests).toHaveLength(1);
  expect(ghl.requests[0]?.url.searchParams.get("locationId")).toBe("loc-A");

  // The SQL result — not the rows — is what went back to the model.
  const toolResults = mock()
    .llm.getRequests()
    .flatMap((entry) => JSON.stringify(entry.body ?? ""))
    .join("\n");
  expect(toolResults).toContain('\\"n\\":3');
});
