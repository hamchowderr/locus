import { describe, expect, it } from "vitest";
import { PRODUCTION_SETTINGS, settingsProblems } from "./settings-check.ts";

const complete = Object.fromEntries(
  Object.values(PRODUCTION_SETTINGS)
    .flat()
    .map((name) => [name, "set"]),
);

describe("settingsProblems", () => {
  it("is empty when every production setting is present", () => {
    expect(settingsProblems(complete)).toEqual([]);
  });

  it("names the missing settings by feature, never a value", () => {
    const env = { ...complete, GHL_APP_ID: "", TURSO_ORG: undefined, GHL_CLIENT_SECRET: "s3cret" };
    const problems = settingsProblems(env);
    expect(problems).toEqual([
      "client databases: TURSO_ORG not set",
      "gohighlevel: GHL_APP_ID not set",
    ]);
    expect(problems.join(" ")).not.toContain("s3cret");
  });

  it("flags development modes left on", () => {
    expect(settingsProblems({ ...complete, GHL_MODE: "stub", EMAIL_MODE: "console" })).toEqual([
      "GHL_MODE is set to a development mode",
      "EMAIL_MODE is set to a development mode",
    ]);
  });

  it("billing is optional, but a Stripe key needs its webhook secret", () => {
    expect(settingsProblems({ ...complete, STRIPE_SECRET_KEY: "sk_live_x" })).toEqual([
      "billing: STRIPE_WEBHOOK_SECRET not set",
    ]);
    expect(
      settingsProblems({ ...complete, STRIPE_SECRET_KEY: "x", STRIPE_WEBHOOK_SECRET: "y" }),
    ).toEqual([]);
  });

  it("needs no sandbox token on Vercel, where the deployment's OIDC token opens sandboxes", () => {
    const env = {
      ...complete,
      LOCUS_SANDBOX_TOKEN: undefined,
      LOCUS_SANDBOX_TEAM_ID: undefined,
      LOCUS_SANDBOX_PROJECT_ID: undefined,
    };
    expect(settingsProblems({ ...env, VERCEL: "1" })).toEqual([]);
    const missing =
      "site builder: LOCUS_SANDBOX_TOKEN, LOCUS_SANDBOX_TEAM_ID, LOCUS_SANDBOX_PROJECT_ID not set";
    expect(settingsProblems(env)).toEqual([missing]);
    expect(settingsProblems({ ...env, VERCEL: "1", LOCUS_SANDBOX: "off" })).toEqual([missing]);
  });

  it("needs DAYTONA_API_KEY instead when sandboxes run on Daytona", () => {
    const env = { ...complete, VERCEL: "1", LOCUS_SANDBOX_PROVIDER: "daytona" };
    expect(settingsProblems(env)).toEqual(["site builder: DAYTONA_API_KEY not set"]);
    expect(settingsProblems({ ...env, DAYTONA_API_KEY: "k" })).toEqual([]);
    expect(settingsProblems({ ...env, LOCUS_SANDBOX_PROVIDER: "elsewhere" })).toEqual([
      "site builder: LOCUS_SANDBOX_PROVIDER must be one of vercel, daytona, e2b",
    ]);
  });
});
