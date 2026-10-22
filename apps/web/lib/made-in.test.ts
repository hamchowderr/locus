import { describe, expect, it } from "vitest";
import type { ThreadItem } from "@/lib/agent-controller/use-threads";
import { threadOf } from "./made-in";

const at = (id: string, extra: Partial<ThreadItem>): ThreadItem => ({
  id,
  title: id,
  archived: false,
  createdAt: "2026-10-22T00:00:00Z",
  updatedAt: "2026-10-22T00:00:00Z",
  ...extra,
});

describe("threadOf", () => {
  it("names the newest thread the main chat started for the site, never its own chat", () => {
    const all = [
      at("own-chat", { siteId: "s1" }),
      at("newer", { siteId: "s1", parentThreadId: "main" }),
      at("older", { siteId: "s1", parentThreadId: "main" }),
      at("other", { siteId: "s2", parentThreadId: "main" }),
    ];
    expect(threadOf(all, "s1")?.id).toBe("newer");
    expect(threadOf(all, "s3")).toBeUndefined();
    expect(threadOf([all[0] as ThreadItem], "s1")).toBeUndefined();
  });
});
