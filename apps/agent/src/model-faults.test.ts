import { type ChaosConfig, LLMock } from "@copilotkit/aimock";
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

async function setUp(helloChaos?: ChaosConfig) {
  const mock = new LLMock({ host: "127.0.0.1", port: 0, logLevel: "silent", strict: true });
  mock.on(
    { userMessage: "Say hello.", hasToolResult: false },
    { content: "Hello there." },
    helloChaos ? { chaos: helloChaos } : {},
  );
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

/** Under the test's own timeout, so a hang fails as "no reply" with the host still open. */
const CHAT_TIMEOUT_MS = 30_000;

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

    const events = await runSampleChat(host, hello, CHAT_TIMEOUT_MS);

    expect(statuses(mock)).toEqual([status, 200]);
    expect(errors(events)).toEqual([]);
    expect(said(events, "Hello there.")).toBe(true);
  });

  test.each([
    ["keeps answering with server errors", { dropRate: 1 }],
    ["keeps rate-limiting", { rateLimitRate: 1 }],
    ["keeps dropping the connection", { disconnectRate: 1 }],
  ])(
    "a model that %s ends the run with one error, and the next message in the thread works",
    async (_what, chaos) => {
      // Only the first message's replies fail, so the second one, in the same thread, can succeed.
      const { mock, host } = await setUp(chaos);

      const events = await runSampleChat(
        host,
        { id: "outage", messages: ["Say hello.", "Are you back?"] },
        CHAT_TIMEOUT_MS,
      );

      expect(errors(events)).toHaveLength(1);
      // Three tries for the first message (the AI SDK's default retries), then one for the second.
      expect(statuses(mock)).toHaveLength(4);
      expect(statuses(mock).at(-1)).toBe(200);
      expect(said(events, "I'm back.")).toBe(true);
      expect(events.at(-1)?.type).toBe("agent_end");
    },
  );

  test("a garbled reply ends the run with an error rather than a made-up answer", async () => {
    const { mock, host } = await setUp();
    mock.setChaos({ malformedRate: 1 });

    const events = await runSampleChat(host, hello, CHAT_TIMEOUT_MS);

    expect(errors(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("agent_end");
    // A reply that parses is not a transport fault, so it is not retried.
    expect(statuses(mock)).toEqual([200]);
  });

  test("a slow model still gets its answer to the member", async () => {
    const { mock, host } = await setUp();
    mock.setChaos({ latencyMs: 2_000 });

    const events = await runSampleChat(host, hello, CHAT_TIMEOUT_MS);

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

    const events = await runSampleChat(host, { id: "tag", messages: [message] }, CHAT_TIMEOUT_MS);

    expect(errors(events)).toHaveLength(1);
    expect(statuses(mock)).toEqual([200, 500, 500, 500]);
    expect(writes(host).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /contacts/fake-contact-01/tags",
    ]);
  });
});
