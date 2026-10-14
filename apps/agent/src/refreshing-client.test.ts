import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { refreshingClient } from "./refreshing-client.ts";

function fakeClient(token: number) {
  return {
    execute: vi.fn(async () => ({ token })),
    close: vi.fn(),
  } as unknown as Client & { close: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshingClient", () => {
  test("opens a client with a fresh token once the old one is due, and closes the old one later", async () => {
    vi.useFakeTimers();
    let time = 0;
    const opened: ReturnType<typeof fakeClient>[] = [];
    const client = refreshingClient(
      async () => {
        const c = fakeClient(opened.length + 1);
        opened.push(c);
        return c;
      },
      { renewMs: 1_000, graceMs: 500, now: () => time },
    );

    expect(await client.execute("select 1")).toEqual({ token: 1 });
    time = 999;
    expect(await client.execute("select 1")).toEqual({ token: 1 });
    time = 1_000;
    // The renewal starts; this query still runs on the current client.
    expect(await client.execute("select 1")).toEqual({ token: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await client.execute("select 1")).toEqual({ token: 2 });
    expect(opened).toHaveLength(2);

    expect(opened[0]?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(opened[0]?.close).toHaveBeenCalled();
    expect(opened[1]?.close).not.toHaveBeenCalled();
  });

  test("a failed renewal keeps the current client, and is tried again later", async () => {
    let time = 0;
    let attempts = 0;
    const client = refreshingClient(
      async () => {
        attempts += 1;
        if (attempts === 2) throw new Error("token service down");
        return fakeClient(attempts);
      },
      { renewMs: 1_000, retryMs: 100, now: () => time },
    );
    expect(await client.execute("select 1")).toEqual({ token: 1 });
    time = 1_000;
    expect(await client.execute("select 1")).toEqual({ token: 1 });
    await Promise.resolve();
    expect(attempts).toBe(2);
    time = 1_050;
    expect(await client.execute("select 1")).toEqual({ token: 1 });
    expect(attempts).toBe(2);
    time = 1_100;
    await client.execute("select 1");
    await new Promise((r) => setTimeout(r, 0));
    expect(await client.execute("select 1")).toEqual({ token: 3 });
  });

  test("the first open failing is reported, and the next call tries again", async () => {
    let attempts = 0;
    const client = refreshingClient(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("token service down");
        return fakeClient(attempts);
      },
      { renewMs: 1_000 },
    );
    await expect(client.execute("select 1")).rejects.toThrow(/token service down/);
    expect(await client.execute("select 1")).toEqual({ token: 2 });
  });

  test("once closed, it opens nothing more", async () => {
    let attempts = 0;
    const client = refreshingClient(
      async () => {
        attempts += 1;
        return fakeClient(attempts);
      },
      { renewMs: 1_000 },
    );
    await client.execute("select 1");
    client.close();
    await expect(client.execute("select 1")).rejects.toThrow(/closed/);
    expect(attempts).toBe(1);
  });
});
