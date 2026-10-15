import { createClient } from "@libsql/client";
import { LocalProvisioner, openControlDb, TursoProvisioner } from "@locus/db";
import { describe, expect, it } from "vitest";
import { settingsProblems, unresolvedSettings } from "./settings-check.ts";

const TOKEN = "turso-platform-token-never-logged";
// `${path}` as text: what Coolify passed through unfilled.
const ref = (path: string) => `$${"{"}${path}}`;

function turso(status: number | "hang") {
  const fetch = (async () =>
    status === "hang"
      ? new Promise<Response>(() => {})
      : new Response(JSON.stringify(status === 200 ? { group: {} } : { error: "bad token" }), {
          status,
        })) as unknown as typeof globalThis.fetch;
  return new TursoProvisioner({
    org: "hamchowderr",
    group: "locus",
    apiToken: TOKEN,
    fetch,
    baseUrl: "https://turso.test",
  });
}

const goodDb = () => openControlDb(":memory:");
const local = () => new LocalProvisioner(".data/test-tenants");

describe("the agent's settings check", () => {
  it("names settings left as unfilled references, and never their values", () => {
    const env = {
      TURSO_API_TOKEN: ref("dev.shared.TURSO_API_TOKEN"),
      GHL_APP_ID: "{{team.GHL_APP_ID}}",
      TURSO_ORG: "hamchowderr",
      UNRELATED: ref("not.ours"),
    };
    expect(unresolvedSettings(env)).toEqual(["GHL_APP_ID", "TURSO_API_TOKEN"]);
  });

  it("finds nothing when every setting works", async () => {
    expect(
      await settingsProblems({
        env: { TURSO_ORG: "hamchowderr" },
        db: goodDb(),
        provisioner: turso(200),
      }),
    ).toEqual([]);
    expect(await settingsProblems({ env: {}, db: goodDb(), provisioner: local() })).toEqual([]);
  });

  it("reports a token Turso refuses without the token itself", async () => {
    const problems = await settingsProblems({
      env: { TURSO_API_TOKEN: ref("dev.shared.TURSO_API_TOKEN") },
      db: goodDb(),
      provisioner: turso(401),
    });
    expect(problems).toEqual([
      "TURSO_API_TOKEN holds an unfilled reference instead of a value",
      expect.stringMatching(
        /^Turso refused TURSO_ORG, TURSO_GROUP or TURSO_API_TOKEN: .*bad token/,
      ),
    ]);
    expect(problems.join("\n")).not.toContain(TOKEN);
  });

  it("reports a control database it cannot query", async () => {
    const client = createClient({ url: ":memory:" });
    client.close();
    const db = Object.assign(goodDb(), { $client: client });
    const problems = await settingsProblems({ env: {}, db, provisioner: local() });
    expect(problems).toEqual([expect.stringMatching(/^the control database cannot be queried: /)]);
  });

  it("reports a probe that never answers, so a verdict is always logged", async () => {
    const problems = await settingsProblems({
      env: {},
      db: goodDb(),
      provisioner: turso("hang"),
      timeoutMs: 20,
    });
    expect(problems).toEqual([expect.stringMatching(/Turso refused .*no answer in 20 ms/)]);
  });
});
