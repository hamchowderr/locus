import { describe, expect, it } from "vitest";
import { GHL_SCOPES } from "./ghl-scopes.ts";

describe("GHL_SCOPES", () => {
  it("lists the 148 scopes ticked on the app, once each", () => {
    expect(GHL_SCOPES).toHaveLength(148);
    expect(new Set(GHL_SCOPES).size).toBe(GHL_SCOPES.length);
  });

  it("includes what the connect flow itself needs", () => {
    // `GET /oauth/installed-locations` and `POST /oauth/location-token`.
    expect(GHL_SCOPES).toContain("oauth.readonly");
    expect(GHL_SCOPES).toContain("oauth.write");
    expect(GHL_SCOPES).toContain("locations.readonly");
  });

  it("holds only well-formed scope names", () => {
    for (const scope of GHL_SCOPES)
      expect(scope).toMatch(/^[a-z][a-zA-Z-]*(\/[a-zA-Z-]+)*\.(readonly|write|read)$/);
  });
});
