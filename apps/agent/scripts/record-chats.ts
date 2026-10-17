/**
 * Records the sample chats in `fixtures/chats.json` from a real model, so staging can replay
 * them for free. Manual only, never in CI; it spends real tokens. From the repository root:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @locus/agent record:chats [chat-id …]
 *
 * `LOCUS_RECORD_MODEL` picks the model (a Mastra id, default `anthropic/claude-opus-5-5`; record
 * with the model staging and production run). GoHighLevel is the fake sub-account in
 * `src/sample-chats.ts`; nothing reaches a real one. AIMock proxies each model call to
 * Anthropic (its OpenAI-compatible endpoint) and writes it to `fixtures/recorded/<chat id>/`, replacing that chat's earlier
 * recording. The key is only forwarded: AIMock's fixtures hold the request's match and the
 * response, never its headers, and this script checks each file for the key before keeping it.
 * Review the recordings before committing them.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { RECORDED_DIR } from "../src/recorded-fixtures.ts";
import { loadSampleChats, runSampleChat, startSampleHost } from "../src/sample-chats.ts";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY to record (it is never printed or saved).");
  process.exit(1);
}
const modelId = (process.env.LOCUS_RECORD_MODEL ??
  "anthropic/claude-opus-5-5") as `${string}/${string}`;
if (!modelId.includes("/")) {
  console.error("LOCUS_RECORD_MODEL is a Mastra model id, e.g. anthropic/claude-opus-5-5.");
  process.exit(1);
}
const only = process.argv.slice(2);
const chats = loadSampleChats().filter((c) => only.length === 0 || only.includes(c.id));
if (chats.length === 0) {
  console.error(`No sample chat is called ${only.join(", ")}.`);
  process.exit(1);
}

let failed = false;
for (const sample of chats) {
  // Record beside the chat's last good recording and replace it only once this one passes.
  const dir = join(RECORDED_DIR, `${sample.id}.partial`);
  const done = join(RECORDED_DIR, sample.id);
  rmSync(dir, { recursive: true, force: true });
  // A mock per chat, so no chat replays another's recording.
  const mock = new LLMock({ host: "127.0.0.1", port: 0, logLevel: "warn" });
  await mock.start();
  mock.enableRecording({
    // Mastra calls a model at a URL through the OpenAI chat API, so this records through
    // Anthropic's OpenAI-compatible endpoint, the same API the scripted model replays on.
    providers: { openai: "https://api.anthropic.com" },
    fixturePath: dir,
  });
  const host = await startSampleHost({ id: modelId, url: `${mock.url}/v1`, apiKey: key });
  try {
    const events = await runSampleChat(host, sample);
    if (events.some((e) => e.type === "error")) throw new Error("the run ended in an error");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    if (files.length === 0) throw new Error("no model call was recorded");
    for (const file of files) {
      if (readFileSync(join(dir, file), "utf8").includes(key)) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error("a recording held the API key; this chat's recording was deleted");
      }
    }
    rmSync(done, { recursive: true, force: true });
    renameSync(dir, done);
    console.info(`${sample.id}: ${files.length} model calls recorded in ${done}`);
  } catch (error) {
    failed = true;
    console.error(`${sample.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await host.close();
    await mock.stop();
  }
}
process.exit(failed ? 1 : 0);
