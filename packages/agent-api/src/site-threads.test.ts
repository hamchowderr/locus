import { LibSQLStore } from "@mastra/libsql";
import { describe, expect, test } from "vitest";
import { WORK_THREAD_KEY } from "./mastra/lib/work-thread-info.ts";
import { clientSiteThreads } from "./work-threads.ts";

describe("the sites threads are about", () => {
  test("a work thread is tagged with one site, once; an ordinary chat never", async () => {
    const storage = new LibSQLStore({ id: "client", url: ":memory:" });
    await storage.init();
    const memory = await storage.getStore("memory");
    if (!memory) throw new Error("no memory store");
    const now = new Date();
    const save = (id: string, metadata: Record<string, unknown>) =>
      memory.saveThread({
        thread: {
          id,
          resourceId: "client:loc-A",
          title: id,
          createdAt: now,
          updatedAt: now,
          metadata,
        },
      });
    await save("work", {
      [WORK_THREAD_KEY]: { parentThreadId: "chat", title: "Site", status: "working" },
    });
    await save("chat", {});
    const threads = clientSiteThreads(storage);

    expect(await threads.of("work")).toEqual({ work: true, siteId: undefined });
    expect(await threads.tag("work", "site-1")).toBe(true);
    expect(await threads.tag("work", "site-1")).toBe(true);
    expect(await threads.tag("work", "site-2")).toBe(false);
    expect(await threads.of("work")).toEqual({ work: true, siteId: "site-1" });
    // The work thread's own state is kept.
    const work = await memory.getThreadById({ threadId: "work" });
    expect(
      (work?.metadata as Record<string, unknown> | undefined)?.[WORK_THREAD_KEY],
    ).toMatchObject({
      status: "working",
    });

    expect(await threads.tag("chat", "site-1")).toBe(false);
    expect(await threads.of("chat")).toEqual({ work: false, siteId: undefined });
    expect(await threads.of("nope")).toBeNull();
  });
});
