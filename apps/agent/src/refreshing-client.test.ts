import type { Client } from "@libsql/client";
import { describe, expect, test, vi } from "vitest";
import { refreshingClient } from "./refreshing-client.ts";

function fakeClient(token: number) {
  return {
    execute: vi.fn(async () => ({ token })),
    close: vi.fn(),
  } as unknown as Client & { close: ReturnType<typeof vi.fn> };
}

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
    expect(await client.execute("select 1")).toEqual({ token: 2 });
    expect(opened).toHaveLength(2);

    expect(opened[0]?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(opened[0]?.close).toHaveBeenCalled();
    expect(opened[1]?.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("a failed open is tried again on the next call", async () => {
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
});
