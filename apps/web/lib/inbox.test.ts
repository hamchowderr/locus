import { afterEach, describe, expect, it, vi } from "vitest";
import { readInbox } from "./inbox.ts";

afterEach(() => vi.restoreAllMocks());

const row = {
  id: "conv1",
  contactId: "c1",
  contact: "Jordan Visitor",
  channel: "Live chat",
  preview: "Hi",
  at: new Date("2026-10-14T12:00:00Z"),
  unread: 1,
};

describe("the chat's Inbox", () => {
  it("lists the conversations, dates as text, with whether drafting is on", async () => {
    expect(
      await readInbox(
        async () => [row],
        async () => true,
      ),
    ).toEqual({
      state: "ok",
      drafting: true,
      conversations: [{ ...row, at: "2026-10-14T12:00:00.000Z" }],
    });
  });

  it("says GoHighLevel isn't set up when building the call throws NotConfigured", async () => {
    const missing = Object.assign(new Error("Locus is not configured: GHL_CLIENT_ID"), {
      name: "NotConfigured",
    });
    const view = await readInbox(
      () => {
        throw missing;
      },
      async () => false,
    );
    expect(view).toEqual({ state: "not-configured" });
  });

  it("logs only the error's name when GoHighLevel fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("duplicate contact pat@example.test"), {
      name: "GhlError",
    });
    const view = await readInbox(
      async () => {
        throw failure;
      },
      async () => true,
    );
    expect(view).toEqual({ state: "unavailable", drafting: true });
    expect(JSON.stringify(error.mock.calls)).not.toContain("pat@example.test");
    expect(error.mock.calls[0]).toContain("GhlError");
  });

  it("gives up on a slow GoHighLevel", async () => {
    const view = await readInbox(
      () => new Promise(() => {}),
      async () => false,
      5,
    );
    expect(view).toEqual({ state: "unavailable", drafting: false });
  });
});
