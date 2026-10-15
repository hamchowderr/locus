import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Vitest resolves imports the way a bundler does, so only plain Node shows whether the server
// can actually load the way the container starts it. It imports what server.ts imports without
// starting it. Loading the whole graph in a fresh process is slow on CI, hence the long timeout.
describe("starting the server", () => {
  const load = (flags: string[]) =>
    spawnSync(
      process.execPath,
      [
        ...flags,
        "--input-type=module",
        "-e",
        "await import('./src/host.ts'); await import('./src/scripted-model.ts')",
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );

  test("plain Node loads every module the server imports", () => {
    const run = load(["--import", "./src/extensionless.ts"]);
    expect(run.stderr).not.toMatch(/ERR_[A-Z_]+/);
    expect(run.status).toBe(0);
  }, 60_000);

  test("the container and `pnpm start` preload the same hook", () => {
    expect(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")).toContain(
      '"--import", "./apps/agent/src/extensionless.ts"',
    );
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.start).toContain("--import ./src/extensionless.ts");
  });
});
