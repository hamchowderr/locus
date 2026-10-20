import type { AuthorizedClient } from "@locus/auth";
import type { SiteDeps } from "@locus/connect";
import { describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ state: "live" as string | Error }));
vi.mock("@locus/connect", async (actual) => ({
  ...(await actual<typeof import("@locus/connect")>()),
  siteDomainStatus: async () => {
    if (status.state instanceof Error) throw status.state;
    return { domain: "www.acme.test", state: status.state, records: [] };
  },
}));

const { siteAddress } = await import("./host.ts");
const deps = {} as SiteDeps;
const client = {} as AuthorizedClient;
const row = { id: "s1", customDomain: "www.acme.test", deployUrl: "https://acme.vercel.app" };

describe("siteAddress", () => {
  it("is the site's own domain once it is live, and its Vercel address until then", async () => {
    status.state = "live";
    expect(await siteAddress(deps, client, row)).toBe("https://www.acme.test");
    status.state = "point";
    expect(await siteAddress(deps, client, row)).toBe("https://acme.vercel.app");
    status.state = new Error("Vercel is down");
    expect(await siteAddress(deps, client, row)).toBe("https://acme.vercel.app");
    expect(await siteAddress(deps, client, { ...row, customDomain: null, deployUrl: null })).toBe(
      null,
    );
  });
});
