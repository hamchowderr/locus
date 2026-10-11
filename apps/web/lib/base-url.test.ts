import { describe, expect, it } from "vitest";
import { deploymentBaseUrl } from "./base-url.ts";

describe("deploymentBaseUrl", () => {
  it("is the branch URL on a Vercel preview", () => {
    expect(
      deploymentBaseUrl({
        VERCEL_ENV: "preview",
        VERCEL_BRANCH_URL: "locus-git-staging-otaku-solutions.vercel.app",
        BETTER_AUTH_URL: "https://elsewhere.test",
      }),
    ).toBe("https://locus-git-staging-otaku-solutions.vercel.app");
  });

  it("is BETTER_AUTH_URL in production and locally", () => {
    const env = {
      VERCEL_ENV: "production",
      VERCEL_BRANCH_URL: "locus-git-main-otaku-solutions.vercel.app",
      BETTER_AUTH_URL: "https://locus.otakusolutions.io",
    };
    expect(deploymentBaseUrl(env)).toBe("https://locus.otakusolutions.io");
    expect(deploymentBaseUrl({ BETTER_AUTH_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000",
    );
    expect(deploymentBaseUrl({})).toBeUndefined();
  });
});
