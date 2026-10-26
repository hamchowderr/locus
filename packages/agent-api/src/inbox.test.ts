import { describe, expect, test } from "vitest";
import { draftBrief } from "./inbox.ts";

describe("a drafted reply's brief", () => {
  const brief = draftBrief({
    conversationId: "conv1",
    contactId: "contact1",
    channel: "Live_Chat",
    messageId: "msg1",
  });

  test("names the message by its ids only", () => {
    expect(brief).toContain("conversation conv1");
    expect(brief).toContain("contact contact1");
    expect(brief).toContain("message msg1");
  });

  test("asks for the one-line summary, unquoted, before the send", () => {
    // The summary is the run's own text, kept across the approval pause; what it read is not.
    const summary = brief.indexOf("say in one line");
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(brief.indexOf("conversations.send-a-new-message"));
    expect(brief).toMatch(/without quoting the message/);
  });

  test("says a returned send was approved and went out", () => {
    // A run resumed after the yes said the reply was still waiting for approval.
    expect(brief).toMatch(/once it returns, the reply has been sent/);
    // The next one took back its own summary, as if it had never read the conversation.
    expect(brief).toMatch(/do not review or correct what you wrote before the yes/);
  });
});
