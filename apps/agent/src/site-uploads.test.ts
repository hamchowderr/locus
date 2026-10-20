import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SiteUploadDeps, siteUploads, siteUploadsOff, TICKET_HEADER } from "./site-uploads.ts";

// The route's own part: the ticket is claimed before any body is read, the body is held to the
// ticket's size and kept moving, uploads at once are capped, and nothing is left on disk. What a
// ticket allows is tested in @locus/connect (site-files.test.ts); here it is replaced.

const calls = vi.hoisted(() => ({
  claimed: [] as { ticket: string | null; contentType: string; size: number | null }[],
  kept: [] as { bytes: number; type: string }[],
}));

vi.mock("@locus/connect", async (actual) => ({
  ...(await actual<typeof import("@locus/connect")>()),
  claimSiteUploadTicket: async (
    _deps: unknown,
    input: { ticket: string | null; contentType: string; size: number | null },
  ) => {
    calls.claimed.push(input);
    if (input.ticket !== "good") {
      return { answer: { status: 401, body: { error: "That upload has expired. Try again." } } };
    }
    return { claim: { siteId: "site-1", name: "clip.mp4", contentType: "video/mp4", size: 1000 } };
  },
  keepTicketedFile: async (_deps: unknown, _claim: unknown, file: Blob) => {
    calls.kept.push({ bytes: (await file.arrayBuffer()).byteLength, type: file.type });
    return { status: 200, body: { fileId: "file1", url: "https://media.test/file1" } };
  },
}));

const deps = {} as SiteUploadDeps;
const URL = "https://agent.test/site-files/upload";

const put = (ticket: string | null, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(URL, {
    method: "PUT",
    body,
    headers: {
      "content-type": "video/mp4",
      ...(ticket === null ? {} : { [TICKET_HEADER]: ticket }),
      ...headers,
    },
    duplex: "half",
  } as RequestInit);

/** A body that sends `first` bytes and then waits until `release` is called. */
function stalled(first: number) {
  let release = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(first));
      release = () => {
        controller.enqueue(new Uint8Array(1000 - first));
        controller.close();
      };
    },
  });
  return { body, release: () => release() };
}

const leftovers = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith("locus-upload-"));

beforeEach(() => {
  calls.claimed = [];
  calls.kept = [];
});

describe("the agent server's site uploads", () => {
  it("answers the browser's CORS check, and only PUT otherwise", async () => {
    const handle = siteUploads(deps);
    const pre = await handle(new Request(URL, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(pre.headers.get("access-control-allow-headers")).toContain(TICKET_HEADER);
    expect((await handle(new Request(URL))).status).toBe(404);
  });

  it("claims the ticket, with what the request says it is, before reading the body", async () => {
    const handle = siteUploads(deps);
    const answer = await handle(put("forged", new Uint8Array(10), { "content-length": "10" }));
    expect(answer.status).toBe(401);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(calls.claimed).toEqual([{ ticket: "forged", contentType: "video/mp4", size: 10 }]);
    expect(calls.kept).toEqual([]);
    expect((await handle(put("good", new Uint8Array(10), { "content-length": "x" }))).status).toBe(
      400,
    );
  });

  it("streams the file to disk, hands it on, and leaves nothing behind", async () => {
    const before = await leftovers();
    const answer = await siteUploads(deps)(put("good", new Uint8Array(1000)));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ fileId: "file1", url: "https://media.test/file1" });
    expect(calls.kept).toEqual([{ bytes: 1000, type: "video/mp4" }]);
    expect(await leftovers()).toEqual(before);
  });

  it("refuses a body bigger than its ticket, even without a length up front", async () => {
    const before = await leftovers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    expect((await siteUploads(deps)(put("good", stream))).status).toBe(400);
    expect(calls.kept).toEqual([]);
    expect(await leftovers()).toEqual(before);
  });

  it("cuts off a sender that stops sending, and removes what it sent", async () => {
    const before = await leftovers();
    const { body } = stalled(100);
    const answer = await siteUploads(deps, console.error, { idleMs: 50 })(put("good", body));
    expect(answer.status).toBe(400);
    expect(calls.kept).toEqual([]);
    expect(await leftovers()).toEqual(before);
  });

  it("takes only so many uploads at once", async () => {
    const handle = siteUploads(deps, console.error, { maxActive: 1 });
    const slow = stalled(100);
    const first = handle(put("good", slow.body));
    await vi.waitFor(() => expect(calls.claimed).toHaveLength(1));
    const busy = await handle(put("good", new Uint8Array(1000)));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("30");
    expect(busy.headers.get("access-control-allow-origin")).toBe("*");
    slow.release();
    expect((await first).status).toBe(200);
    expect((await handle(put("good", new Uint8Array(1000)))).status).toBe(200);
  });

  it("says plainly, and readably for the browser, when this server takes no uploads", async () => {
    const off = siteUploadsOff(put("good", new Uint8Array(1)));
    expect(off.status).toBe(503);
    expect(off.headers.get("access-control-allow-origin")).toBe("*");
    expect(await off.json()).toEqual({ error: "Files can be up to 4 MB here." });
  });
});
