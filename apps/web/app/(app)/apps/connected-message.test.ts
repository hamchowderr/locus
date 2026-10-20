import { describe, expect, it } from "vitest";
import { connectedPath } from "./connected-message";

describe("connectedPath", () => {
  it("goes back to the Apps page naming the app that connected", () => {
    expect(connectedPath({ toolkit: "gmail", status: "success" })).toBe("/apps?connected=gmail");
  });

  it("shows an error when Composio says the sign-in failed", () => {
    expect(connectedPath({ toolkit: "gmail", status: "failed" })).toMatch(/^\/apps\?error=/);
  });

  it("keeps a strange app name inside the query", () => {
    expect(connectedPath({ toolkit: "a&b=c", status: "success" })).toBe(
      "/apps?connected=a%26b%3Dc",
    );
  });
});
