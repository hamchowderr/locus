import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { afterEach, describe, expect, test } from "vitest";
import { forReplay, loadRecordedChat, loadRecordedChats } from "./recorded-fixtures.ts";
import {
  loadSampleChats,
  runSampleChat,
  type SampleChat,
  startSampleHost,
} from "./sample-chats.ts";
import { startScriptedModel } from "./scripted-model.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "locus-recorded-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function started(mock: LLMock) {
  await mock.start();
  cleanups.push(() => mock.stop());
  return mock;
}

async function sampleHost(model: Parameters<typeof startSampleHost>[0]) {
  const host = await startSampleHost(model);
  cleanups.push(host.close);
  return host;
}

/** Requests the mock answered with no fixture. */
function unmatched(mock: LLMock) {
  return mock.getRequests().filter((e) => e.response.fixture === null);
}

const calls = (host: { ghl: { requests: { method: string; url: URL }[] } }) =>
  host.ghl.requests.map((r) => `${r.method} ${r.url.pathname}`);

describe("recorded chats", () => {
  test("a chat recorded through AIMock keeps no key and replays through the agent, step by step", async () => {
    // The provider: a second mock, so recording runs end to end with no network.
    const upstream = await started(new LLMock({ host: "127.0.0.1", port: 0, logLevel: "silent" }));
    const question = "How many tags are there, and how many contacts?";
    const query = (as: string, operation: string) =>
      JSON.stringify({ sources: [{ as, operation }], sql: `select count(*) as n from ${as}` });
    upstream.on(
      { userMessage: question, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "toolu_step1",
            name: "query_data",
            arguments: query("tags", "locations.get-location-tags"),
          },
        ],
      },
    );
    upstream.on(
      { toolCallId: "toolu_step1" },
      {
        toolCalls: [
          {
            id: "toolu_step2",
            name: "query_data",
            arguments: query("c", "contacts.search-contacts-advanced"),
          },
        ],
      },
    );
    upstream.on({ toolCallId: "toolu_step2" }, { content: "There are 4 tags and 6 contacts." });

    const recorded = await tempDir();
    const sample: SampleChat = { id: "two-reads", messages: [question] };
    const recorder = await started(new LLMock({ host: "127.0.0.1", port: 0, logLevel: "silent" }));
    recorder.enableRecording({
      providers: { openai: upstream.url },
      fixturePath: join(recorded, sample.id),
    });
    const key = "sk-ant-test-key-that-must-not-be-saved";
    const live = await sampleHost({
      id: "anthropic/claude-test",
      url: `${recorder.url}/v1`,
      apiKey: key,
    });
    await runSampleChat(live, sample, 10_000);

    const files = await readdir(join(recorded, sample.id));
    expect(files).toHaveLength(3);
    for (const file of files) {
      const text = await readFile(join(recorded, sample.id, file), "utf8");
      expect(text).not.toContain(key);
      expect(text.toLowerCase()).not.toContain("authorization");
    }

    const { mock, model } = await startScriptedModel({ recordedDir: recorded, strict: true });
    cleanups.push(() => mock.stop());
    const replay = await sampleHost(model);
    const events = await runSampleChat(replay, sample, 10_000);
    expect(unmatched(mock)).toEqual([]);
    expect(mock.getRequests()).toHaveLength(3);
    expect(JSON.stringify(events)).toContain("There are 4 tags and 6 contacts.");
    expect(calls(replay)).toEqual(calls(live));
  });

  test("a recorded fixture file replays whatever the tool returned and however long the thread", async () => {
    // The recorder's on-disk format: one file per model call, named by time.
    const dir = join(await tempDir(), "count-vip");
    mkdirSync(dir, { recursive: true });
    const file = (name: string, fixture: object) =>
      writeFile(join(dir, name), JSON.stringify({ fixtures: [fixture] }, null, 2));
    const userMessage = "How many contacts are tagged vip?";
    await file("openai-2026-10-17T10-00-00-000Z-aaaaaaaa.json", {
      match: { userMessage, model: "claude-opus-5-5", turnIndex: 0, hasToolResult: false },
      response: { toolCalls: [{ name: "query_data", arguments: "{}", id: "toolu_a" }] },
      metadata: { systemHash: "00000000" },
    });
    await file("openai-2026-10-17T10-00-01-000Z-bbbbbbbb.json", {
      match: { userMessage, model: "claude-opus-5-5", turnIndex: 1, hasToolResult: true },
      response: { toolCalls: [{ name: "query_data", arguments: "{}", id: "toolu_b" }] },
    });
    await file("openai-2026-10-17T10-00-02-000Z-cccccccc.json", {
      match: { userMessage, model: "claude-opus-5-5", turnIndex: 2, hasToolResult: true },
      response: { content: "Three contacts are tagged vip." },
    });

    const fixtures = loadRecordedChat(dir);
    expect(fixtures.map((f) => f.match)).toEqual([
      { userMessage: /^How many contacts are tagged vip\?$/, turnIndex: 0, hasToolResult: false },
      { toolCallId: "toolu_a" },
      { toolCallId: "toolu_b" },
    ]);

    const { mock } = await startScriptedModel({ recordedDir: join(dir, ".."), strict: true });
    cleanups.push(() => mock.stop());
    const ask = async (messages: object[]) => {
      const res = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "locus-scripted", messages }),
      });
      return { status: res.status, text: await res.text() };
    };
    // A thread that already holds two earlier exchanges, and tool results unlike the recording's.
    const earlier = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "and again" },
      { role: "assistant", content: "Hi again." },
    ];
    const user = { role: "user", content: userMessage };
    const used = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "query_data", arguments: "{}" } }],
    });
    const result = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content });

    expect((await ask([...earlier, user])).text).toContain("toolu_a");
    const second = await ask([...earlier, user, used("toolu_a"), result("toolu_a", "live rows")]);
    expect(second.text).toContain("toolu_b");
    const last = await ask([
      ...earlier,
      user,
      used("toolu_a"),
      result("toolu_a", "live rows"),
      used("toolu_b"),
      result("toolu_b", "different live rows"),
    ]);
    expect(last.text).toContain("Three contacts are tagged vip.");
    // A longer message that merely contains the recorded one is not the recorded chat.
    expect((await ask([{ role: "user", content: `${userMessage} And list them.` }])).status).toBe(
      503,
    );
    expect(unmatched(mock)).toHaveLength(1);
  });

  test("forReplay leaves a fixture with no recorded tool call to chain from as it was, less its model", () => {
    const [fixture] = forReplay([
      {
        match: { userMessage: "hi", model: "claude-opus-5-5", hasToolResult: true },
        response: { content: "x" },
      },
    ]);
    expect(fixture?.match).toEqual({ userMessage: /^hi$/, hasToolResult: true });
  });

  test("every recorded chat replays against the fake sub-account with no unmatched request", {
    timeout: 600_000,
  }, async () => {
    const samples = new Map(loadSampleChats().map((c) => [c.id, c]));
    for (const { id } of loadRecordedChats()) {
      const sample = samples.get(id);
      expect(sample, `fixtures/recorded/${id} has no chat in fixtures/chats.json`).toBeDefined();
      if (!sample) continue;
      const { mock, model } = await startScriptedModel({ strict: true });
      cleanups.push(() => mock.stop());
      const host = await sampleHost(model);
      const events = await runSampleChat(host, sample);
      expect(unmatched(mock), id).toEqual([]);
      expect(
        events.some((e) => e.type === "error"),
        id,
      ).toBe(false);
    }
  });
});
