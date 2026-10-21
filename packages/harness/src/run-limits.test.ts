import { useAimock } from "@locus/testing";
import { Agent, type ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { expect, test } from "vitest";
import { z } from "zod";
import { createLocusAgent } from "./agent.ts";
import { RUN_STOP_CONDITIONS, stopAtStepLimit, stopOnRepeatedFailures } from "./run-limits.ts";

const mock = useAimock();

const model = () => ({
  id: "anthropic/claude-test" as const,
  url: `${mock().url}/v1`,
  apiKey: "test-key",
});

const runCommand = createTool({
  id: "run_command",
  description: "Runs a command.",
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ cmd }) => {
    if (cmd === "ok") return { output: "fine" };
    throw new Error("command failed");
  },
});

let runs = 0;

/** The model calls `tool` with `args(n)` on its nth step for `steps` steps, then says it's done. */
function loopOn(args: (n: number) => string, steps = 12, tool = "run_command") {
  // Ids unique to this test, so one test's turns never answer another's.
  const id = (n: number) => `run${runs}_call_${n}`;
  runs++;
  const prompt = `Build it ${runs}`;
  mock().llm.on(
    { userMessage: prompt, hasToolResult: false },
    { toolCalls: [{ id: id(1), name: tool, arguments: args(1) }] },
  );
  for (let n = 1; n < steps; n++) {
    mock().llm.on(
      { toolCallId: id(n) },
      { toolCalls: [{ id: id(n + 1), name: tool, arguments: args(n + 1) }] },
    );
  }
  mock().llm.on({ toolCallId: id(steps) }, { content: "Done." });
  return prompt;
}

test("a run stops after the same tool fails three steps in a row", async () => {
  const prompt = loopOn(() => '{"cmd":"bad"}');
  const agent = new Agent({
    id: "a",
    name: "a",
    instructions: "Build things.",
    model: model(),
    tools: { run_command: runCommand },
    defaultOptions: { stopWhen: stopOnRepeatedFailures() },
  });

  const result = await agent.generate(prompt, { maxSteps: 1000 });

  expect(result.steps).toHaveLength(3);
});

test("arguments the model can't send right count as failures too", async () => {
  const prompt = loopOn(() => "{not json");
  const agent = new Agent({
    id: "a",
    name: "a",
    instructions: "Build things.",
    model: model(),
    tools: { run_command: runCommand },
    defaultOptions: { stopWhen: stopOnRepeatedFailures() },
  });

  const result = await agent.generate(prompt, { maxSteps: 1000 });

  expect(result.steps).toHaveLength(3);
});

test("a step that works starts the count again", async () => {
  // bad, bad, ok, bad, bad, bad: the third failure in a row is step 6.
  const prompt = loopOn((n) => (n === 3 ? '{"cmd":"ok"}' : '{"cmd":"bad"}'));
  const agent = new Agent({
    id: "a",
    name: "a",
    instructions: "Build things.",
    model: model(),
    tools: { run_command: runCommand },
    defaultOptions: { stopWhen: stopOnRepeatedFailures() },
  });

  const result = await agent.generate(prompt, { maxSteps: 1000 });

  expect(result.steps).toHaveLength(6);
});

const softFail = createTool({
  id: "fetch_reference",
  description: "Fetches a page.",
  inputSchema: z.object({ url: z.string() }),
  execute: async () => ({ error: "That site blocks visitors like us." }),
});

const agentWith = (tools: ToolsInput) =>
  new Agent({
    id: "a",
    name: "a",
    instructions: "Build things.",
    model: model(),
    tools,
    defaultOptions: { stopWhen: stopOnRepeatedFailures() },
  });

test("a tool that returns { error } for the same input three times stops the run", async () => {
  const prompt = loopOn(() => '{"url":"https://a.test"}', 12, "fetch_reference");
  const result = await agentWith({ fetch_reference: softFail }).generate(prompt, {
    maxSteps: 1000,
  });
  expect(result.steps).toHaveLength(3);
});

test("the same tool failing on different inputs is not a loop", async () => {
  // Five different references that all refuse: each is a new try, so the run goes on.
  const prompt = loopOn((n) => JSON.stringify({ url: `https://${n}.test` }), 5, "fetch_reference");
  const result = await agentWith({ fetch_reference: softFail }).generate(prompt, {
    maxSteps: 1000,
  });
  expect(result.text).toBe("Done.");
  expect(result.steps).toHaveLength(6);
});

test("an { error } result is a failure, wrapped by the GHL screen or not", () => {
  const step = (value: unknown) =>
    ({
      content: [
        { type: "tool-call", toolName: "write_file", toolCallId: "x", input: {} },
        {
          type: "tool-result",
          toolName: "write_file",
          toolCallId: "x",
          input: {},
          output: { type: "json", value },
        },
      ],
    }) as never;
  const stop = stopOnRepeatedFailures(2);
  expect(stop({ steps: [step({ error: "no" }), step({ error: "no" })] })).toBe(true);
  expect(stop({ steps: [step({ error: "no" }), step({ ok: true })] })).toBe(false);
  const screened = { warning: "untrusted", result: { error: "no" } };
  expect(stop({ steps: [step(screened), step(screened)] })).toBe(true);
});

test("a run stops at the step limit even when every step works", async () => {
  const prompt = loopOn(() => '{"cmd":"ok"}');
  const agent = new Agent({
    id: "a",
    name: "a",
    instructions: "Build things.",
    model: model(),
    tools: { run_command: runCommand },
    defaultOptions: { stopWhen: stopAtStepLimit(4) },
  });

  const result = await agent.generate(prompt, { maxSteps: 1000 });

  expect(result.steps).toHaveLength(4);
});

test("the Locus agent carries both stops by default", async () => {
  const agent = createLocusAgent({
    model: model(),
    session: { token: "tok", tokenKind: "location", locationId: "loc-A" },
  });
  const { stopWhen } = await agent.getDefaultOptions();
  expect(stopWhen).toBe(RUN_STOP_CONDITIONS);
});
