import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Vitest resolves imports the way a bundler does, so only plain Node shows whether the server
// can actually load the way the container starts it.
describe("starting the server", () => {
  const load = (flags: string[]) =>
    spawnSync(
      process.execPath,
      [...flags, "--input-type=module", "-e", "await import('./src/host.ts')"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );

  test("plain Node loads every module the server imports", () => {
    const run = load(["--import", "./src/extensionless.ts"]);
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Error/);
    expect(run.status).toBe(0);
  });

  test("the container and `pnpm start` preload the same hook", () => {
    expect(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")).toContain(
      '"--import", "./apps/agent/src/extensionless.ts"',
    );
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.start).toContain("--import ./src/extensionless.ts");
  });
});
