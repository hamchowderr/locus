import { LLMock } from "@copilotkit/aimock";
import { afterEach, describe, expect, test } from "vitest";
import {
  runSampleChat,
  type SampleChat,
  type SampleHost,
  startSampleHost,
} from "./sample-chats.ts";

// What a member sees when the model misbehaves: AIMock's chaos faults the model's replies (errors,
// rate limits, dropped connections, garbage, slowness) while the chat runs end to end through the
// agent host, against the fake sub-account. A run must either answer or end with an error; it
// must never hang, and a fault must never repeat a change already made in GoHighLevel.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp() {
  const mock = new LLMock({ host: "127.0.0.1", port: 0, logLevel: "silent", strict: true });
  mock.on({ userMessage: "Say hello.", hasToolResult: false }, { content: "Hello there." });
  mock.on({ userMessage: "Are you back?", hasToolResult: false }, { content: "I'm back." });
  await mock.start();
  cleanups.push(() => mock.stop());
  const host = await startSampleHost({
    id: "anthropic/claude-test",
    url: `${mock.url}/v1`,
    apiKey: "test-key",
  });
  cleanups.push(host.close);
  return { mock, host };
}

const hello: SampleChat = { id: "hello", messages: ["Say hello."] };

type Events = Awaited<ReturnType<typeof runSampleChat>>;
const errors = (events: Events) => events.filter((e) => e.type === "error");
const said = (events: Events, text: string) => JSON.stringify(events).includes(text);
const statuses = (mock: LLMock) => mock.getRequests().map((r) => r.response.status);
const writes = (host: SampleHost) => host.ghl.requests.filter((r) => r.method !== "GET");

// Each test runs the agent host, and the model client backs off between retries.
describe("when the model fails", { timeout: 60_000 }, () => {
  test.each([
    ["a server error", 500],
    ["a rate limit", 429],
  ])("one %s is retried, and the member still gets the answer", async (_what, status) => {
    const { mock, host } = await setUp();
    mock.nextRequestError(status, { message: "try again" });

    const events = await runSampleChat(host, hello);

    expect(statuses(mock)).toEqual([status, 200]);
    expect(errors(events)).toEqual([]);
    expect(said(events, "Hello there.")).toBe(true);
  });

  test.each([
    ["keeps answering with server errors", { dropRate: 1 }],
    ["keeps rate-limiting", { rateLimitRate: 1 }],
    ["keeps dropping the connection", { disconnectRate: 1 }],
  ])(
    "a model that %s ends the run with one error, and the next message works",
    async (_what, chaos) => {
      const { mock, host } = await setUp();
      mock.setChaos(chaos);

      const failed = await runSampleChat(host, hello);

      expect(errors(failed)).toHaveLength(1);
      expect(failed.at(-1)?.type).toBe("agent_end");
      // The model client tries three times, then gives up instead of waiting on the provider.
      expect(statuses(mock)).toHaveLength(3);
      mock.clearChaos();
      const next = await runSampleChat(host, { id: "after", messages: ["Are you back?"] });
      expect(errors(next)).toEqual([]);
      expect(said(next, "I'm back.")).toBe(true);
    },
  );

  test("a garbled reply ends the run with an error rather than a made-up answer", async () => {
    const { mock, host } = await setUp();
    mock.setChaos({ malformedRate: 1 });

    const events = await runSampleChat(host, hello);

    expect(errors(events)).toHaveLength(1);
    expect(said(events, "Hello there.")).toBe(false);
  });

  test("a slow model still gets its answer to the member", async () => {
    const { mock, host } = await setUp();
    mock.setChaos({ latencyMs: 2_000 });

    const events = await runSampleChat(host, hello);

    expect(errors(events)).toEqual([]);
    expect(said(events, "Hello there.")).toBe(true);
  });

  test("a failure after a change does not make the change twice", async () => {
    const { mock, host } = await setUp();
    const message = "Tag Avery as vip.";
    mock.on(
      { userMessage: message, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "fault-write",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.add-tags",
              params: { path: { contactId: "fake-contact-01" }, body: { tags: ["vip"] } },
            }),
          },
        ],
      },
    );
    // The model fails on every try at the step after the change.
    mock.on({ toolCallId: "fault-write" }, { content: "Tagged." }, { chaos: { dropRate: 1 } });

    const events = await runSampleChat(host, { id: "tag", messages: [message] });

    expect(errors(events)).toHaveLength(1);
    expect(statuses(mock)).toEqual([200, 500, 500, 500]);
    expect(writes(host).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /contacts/fake-contact-01/tags",
    ]);
  });
});
