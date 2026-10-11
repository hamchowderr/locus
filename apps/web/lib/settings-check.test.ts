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
    const env = { ...complete, GHL_SCOPES: "", TURSO_ORG: undefined, GHL_CLIENT_SECRET: "s3cret" };
    const problems = settingsProblems(env);
    expect(problems).toEqual([
      "client databases: TURSO_ORG not set",
      "gohighlevel: GHL_SCOPES not set",
    ]);
    expect(problems.join(" ")).not.toContain("s3cret");
  });

  it("flags development modes left on", () => {
    expect(settingsProblems({ ...complete, GHL_MODE: "stub", EMAIL_MODE: "console" })).toEqual([
      "GHL_MODE is set to a development mode",
      "EMAIL_MODE is set to a development mode",
    ]);
  });
});
