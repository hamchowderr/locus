import { describe, expect, it } from "vitest";
import { savedAgo } from "./saved-ago";

describe("savedAgo", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("says how long ago a version was saved, in the largest whole unit", () => {
    expect(savedAgo("2026-10-21T11:59:30Z", now)).toBe("just now");
    expect(savedAgo("2026-10-21T11:55:00Z", now)).toBe("5 minutes ago");
    expect(savedAgo("2026-10-21T09:00:00Z", now)).toBe("3 hours ago");
    expect(savedAgo("2026-10-20T12:00:00Z", now)).toBe("yesterday");
    expect(savedAgo("2025-10-21T12:00:00Z", now)).toBe("last year");
  });
});
