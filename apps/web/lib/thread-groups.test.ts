import { describe, expect, it } from "vitest";
import { ago, groupOf, progressOf } from "../components/chat-project/thread-groups";
import type { ThreadItem } from "./agent-controller/use-threads";

const thread = (over: Partial<ThreadItem>): ThreadItem => ({
  id: "t1",
  title: "Spring tags",
  archived: false,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
  parentThreadId: "chat-1",
  ...over,
});

describe("the thread list's groups", () => {
  it("puts threads where they need attention", () => {
    expect(groupOf(thread({ status: "needs_you" }))).toBe("waiting");
    expect(groupOf(thread({ status: "working" }))).toBe("working");
    expect(groupOf(thread({ status: "done" }))).toBe("idle");
    expect(groupOf(thread({ status: "failed" }))).toBe("idle");
    expect(groupOf(thread({ status: "done", resolved: true }))).toBe("resolved");
  });

  it("never hides a thread that works or waits under Resolved", () => {
    expect(groupOf(thread({ status: "needs_you", resolved: true }))).toBe("waiting");
    expect(groupOf(thread({ status: "working", resolved: true }))).toBe("working");
  });

  it("shows checklist progress as done of total, and nothing without a list", () => {
    expect(
      progressOf([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toBe("1/3");
    expect(progressOf([])).toBeNull();
    expect(progressOf(undefined)).toBeNull();
  });

  it("says how long ago in the short form", () => {
    const now = Date.parse("2026-10-22T12:00:00.000Z");
    expect(ago("2026-10-22T11:59:40.000Z", now)).toBe("now");
    expect(ago("2026-10-22T11:53:00.000Z", now)).toBe("7m");
    expect(ago("2026-10-22T09:00:00.000Z", now)).toBe("3h");
    expect(ago("2026-10-20T12:00:00.000Z", now)).toBe("2d");
  });
});
