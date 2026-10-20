import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { signSiteUploadTicket } from "@locus/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SiteUploadDeps, siteUploads } from "./site-uploads.ts";

// The route's own part: the ticket is looked at before any body is read, the body is held to
// the ticket's size, and nothing is left on disk. What a ticket allows is tested in
// @locus/connect (site-files.test.ts); here the step that keeps the file is replaced.

const kept = vi.hoisted(() => ({
  calls: [] as { ticket: string | null; bytes: number; type: string; contentType: string }[],
}));

vi.mock("@locus/connect", async (actual) => ({
  ...(await actual<typeof import("@locus/connect")>()),
  uploadSiteFileWithTicket: async (
    _deps: unknown,
    input: { ticket: string | null; file: Blob; contentType: string },
  ) => {
    kept.calls.push({
      ticket: input.ticket,
      bytes: (await input.file.arrayBuffer()).byteLength,
      type: input.file.type,
      contentType: input.contentType,
    });
    return { status: 200, body: { fileId: "file1", url: "https://media.test/file1" } };
  },
}));

const TICKET_KEY = new Uint8Array(32).fill(9);
const NOW = Date.parse("2026-10-20T12:00:00Z");
const deps = { ticketKey: TICKET_KEY, now: () => NOW } as unknown as SiteUploadDeps;
const ticketFor = (size: number) =>
  signSiteUploadTicket(
    TICKET_KEY,
    { siteId: "site-1", name: "clip.mp4", contentType: "video/mp4", size },
    NOW,
  ).ticket;

const put = (ticket: string | null, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(
    `https://agent.test/site-files/upload${ticket === null ? "" : `?ticket=${encodeURIComponent(ticket)}`}`,
    {
      method: "PUT",
      body,
      headers: { "content-type": "video/mp4", ...headers },
      duplex: "half",
    } as RequestInit,
  );

async function leftovers() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("locus-upload-"));
}

beforeEach(() => {
  kept.calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the agent server's site uploads", () => {
  it("answers the browser's CORS check, and only PUT otherwise", async () => {
    const handle = siteUploads(deps);
    const pre = await handle(
      new Request("https://agent.test/site-files/upload", { method: "OPTIONS" }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect((await handle(new Request("https://agent.test/site-files/upload"))).status).toBe(404);
  });

  it("refuses a missing or forged ticket before reading the body", async () => {
    const handle = siteUploads(deps);
    for (const ticket of [null, "x.y"]) {
      const answer = await handle(put(ticket, new Uint8Array(10)));
      expect(answer.status).toBe(401);
      expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(kept.calls).toEqual([]);
  });

  it("streams the file to disk, hands it on, and leaves nothing behind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ticket = ticketFor(1000);
    const before = await leftovers();
    const answer = await siteUploads(deps)(put(ticket, new Uint8Array(1000)));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ fileId: "file1", url: "https://media.test/file1" });
    expect(kept.calls).toEqual([
      { ticket, bytes: 1000, type: "video/mp4", contentType: "video/mp4" },
    ]);
    expect(await leftovers()).toEqual(before);
  });

  it("refuses a body bigger than its ticket, even without a length up front", async () => {
    const ticket = ticketFor(1000);
    const before = await leftovers();
    const declared = await siteUploads(deps)(
      put(ticket, new Uint8Array(1001), { "content-length": "1001" }),
    );
    expect(declared.status).toBe(400);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const streamed = await siteUploads(deps)(put(ticket, stream));
    expect(streamed.status).toBe(400);
    expect(kept.calls).toEqual([]);
    expect(await leftovers()).toEqual(before);
  });
});
