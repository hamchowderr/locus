import { describe, expect, it } from "vitest";
import { DaytonaRuntimeProvider } from "./daytona.ts";
import { missingSandboxSettings, sandboxProviderFromEnv, sandboxProviderName } from "./env.ts";
import { VercelRuntimeProvider } from "./vercel.ts";

const VERCEL = {
  LOCUS_SANDBOX_TOKEN: "t",
  LOCUS_SANDBOX_TEAM_ID: "team",
  LOCUS_SANDBOX_PROJECT_ID: "prj",
};

describe("sandboxProviderFromEnv", () => {
  it("stays on Vercel Sandbox unless LOCUS_SANDBOX_PROVIDER says daytona", () => {
    expect(sandboxProviderName({})).toBe("vercel");
    expect(sandboxProviderFromEnv(VERCEL)).toBeInstanceOf(VercelRuntimeProvider);
    expect(sandboxProviderFromEnv({ VERCEL: "1" })).toBeInstanceOf(VercelRuntimeProvider);
    // A Daytona key alone changes nothing.
    expect(sandboxProviderFromEnv({ ...VERCEL, DAYTONA_API_KEY: "k" })).toBeInstanceOf(
      VercelRuntimeProvider,
    );
    expect(sandboxProviderFromEnv({})).toBeNull();
  });

  it("uses Daytona when chosen, and only with its key", () => {
    const env = { ...VERCEL, VERCEL: "1", LOCUS_SANDBOX_PROVIDER: "daytona" };
    expect(sandboxProviderFromEnv(env)).toBeNull();
    expect(sandboxProviderFromEnv({ ...env, DAYTONA_API_KEY: "k" })).toBeInstanceOf(
      DaytonaRuntimeProvider,
    );
  });

  it("is off with LOCUS_SANDBOX=off, whatever the provider", () => {
    expect(sandboxProviderFromEnv({ ...VERCEL, LOCUS_SANDBOX: "off" })).toBeNull();
    expect(
      sandboxProviderFromEnv({
        LOCUS_SANDBOX: "off",
        LOCUS_SANDBOX_PROVIDER: "daytona",
        DAYTONA_API_KEY: "k",
      }),
    ).toBeNull();
  });

  it("refuses an unknown provider without echoing it", () => {
    expect(() => sandboxProviderFromEnv({ LOCUS_SANDBOX_PROVIDER: "s3cr3t" })).toThrow(
      /^LOCUS_SANDBOX_PROVIDER must be one of vercel, daytona$/,
    );
  });
});

describe("missingSandboxSettings", () => {
  it("names what the chosen provider still needs", () => {
    expect(missingSandboxSettings({})).toEqual([
      "LOCUS_SANDBOX_TOKEN",
      "LOCUS_SANDBOX_TEAM_ID",
      "LOCUS_SANDBOX_PROJECT_ID",
    ]);
    expect(missingSandboxSettings({ VERCEL: "1" })).toEqual([]);
    expect(missingSandboxSettings({ VERCEL: "1", LOCUS_SANDBOX: "off" })).toHaveLength(3);
    expect(missingSandboxSettings({ LOCUS_SANDBOX_PROVIDER: "daytona", VERCEL: "1" })).toEqual([
      "DAYTONA_API_KEY",
    ]);
    expect(
      missingSandboxSettings({ LOCUS_SANDBOX_PROVIDER: "daytona", DAYTONA_API_KEY: "k" }),
    ).toEqual([]);
  });
});
