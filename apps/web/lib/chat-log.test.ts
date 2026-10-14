import type { MastraDBMessage } from "@mastra/client-js";
import { describe, expect, it } from "vitest";
import { applyUpdate, lineOf, linesOf } from "./chat-log";

const message = (id: string, role: MastraDBMessage["role"], text?: string): MastraDBMessage => ({
  id,
  role,
  createdAt: new Date(0),
  content: { format: 2, parts: text === undefined ? [] : [{ type: "text", text }] },
});

describe("the chat log", () => {
  it("rebuilds a streamed reply from its text deltas", () => {
    let reply = message("a1", "assistant");
    for (const delta of ["Hello", ", ", "world"]) {
      reply = applyUpdate(reply, { type: "text-delta", delta });
    }
    expect(lineOf(reply)).toEqual({ id: "a1", role: "assistant", text: "Hello, world" });
  });

  it("keeps reasoning out of the text it shows", () => {
    let reply = message("a2", "assistant");
    reply = applyUpdate(reply, { type: "reasoning-delta", index: 0, delta: "Thinking" });
    expect(lineOf(reply)).toBeNull();
    reply = applyUpdate(reply, { type: "text-delta", delta: "Done." });
    expect(lineOf(reply)?.text).toBe("Done.");
  });

  it("shows the user's and the assistant's messages, and skips empty or system ones", () => {
    expect(
      linesOf([
        message("s", "system", "You are Locus."),
        message("u", "user", "Hi"),
        message("t", "assistant"),
        message("a", "assistant", "Hello."),
      ]),
    ).toEqual([
      { id: "u", role: "user", text: "Hi" },
      { id: "a", role: "assistant", text: "Hello." },
    ]);
  });
});
