import { MemorySecretStore } from "@locus/secrets";
import { describe, expect, it } from "vitest";
import type { AgencyGrant } from "./ghl-oauth.ts";
import { HELD_GRANT_MS, holdGrant, peekHeldGrant, takeHeldGrant } from "./held-grant.ts";

const grant: AgencyGrant = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 0,
  scopes: "locations.readonly",
  companyId: "co_1",
  installedBy: "u_1",
};

describe("held marketplace grants", () => {
  it("holds a grant until it is taken, once", async () => {
    let now = 1_000;
    const deps = { secrets: new MemorySecretStore(), now: () => now };
    const id = await holdGrant(deps, grant);
    expect(await peekHeldGrant(deps, id)).toEqual(grant);
    now += HELD_GRANT_MS - 1;
    expect(await takeHeldGrant(deps, id)).toEqual(grant);
    expect(await takeHeldGrant(deps, id)).toBeNull();
  });

  it("drops a grant held past its hour", async () => {
    let now = 1_000;
    const deps = { secrets: new MemorySecretStore(), now: () => now };
    const id = await holdGrant(deps, grant);
    now += HELD_GRANT_MS;
    expect(await peekHeldGrant(deps, id)).toBeNull();
    now = 1_000;
    expect(await peekHeldGrant(deps, id)).toBeNull();
  });

  it("ignores missing and malformed ids", async () => {
    const deps = { secrets: new MemorySecretStore() };
    expect(await peekHeldGrant(deps, undefined)).toBeNull();
    expect(await peekHeldGrant(deps, "../ghl/org")).toBeNull();
  });
});
