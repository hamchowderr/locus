/**
 * Bundles packages/builder/skills/<name>/**.md into src/skills/bundle.generated.ts, so the
 * skills ship inside the package's code and need no files at run time (a bundled server has
 * none). `--check` fails when the bundle is out of date.
 */
import { readFile, writeFile } from "node:fs/promises";
import { bundleSource, readSkillFiles } from "../src/skills/files.ts";

const target = new URL("../src/skills/bundle.generated.ts", import.meta.url);
const source = bundleSource(await readSkillFiles());

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== source) {
    console.error("src/skills/bundle.generated.ts is out of date: run skills:bundle.");
    process.exit(1);
  }
  console.log("Skill bundle is up to date.");
} else {
  await writeFile(target, source);
  console.log("Wrote src/skills/bundle.generated.ts.");
}
