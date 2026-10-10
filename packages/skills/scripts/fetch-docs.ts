/**
 * Refreshes the docs snapshot in `source/` from GHL's live docs export.
 *
 *   node scripts/fetch-docs.ts
 *
 * The snapshot is committed so generation is reproducible and offline, and so a refresh shows up
 * as a reviewable diff. `meta.json` only changes when the content does.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocs } from "../src/docs/parse.ts";

const URL = "https://marketplace.gohighlevel.com/docs/llms/v3/llms-full.txt";
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "source");
const SNAPSHOT = join(SOURCE, "v3-llms-full.txt");
const META = join(SOURCE, "meta.json");

const res = await fetch(URL);
if (!res.ok) throw new Error(`GET ${URL}: ${res.status}`);
const text = await res.text();

// Parse before saving: a format change GHL made should fail here, not after the commit.
const docs = parseDocs(text);
const sha256 = createHash("sha256").update(text).digest("hex");

const previous = existsSync(META)
  ? (JSON.parse(readFileSync(META, "utf8")) as { sha256: string })
  : undefined;
if (previous?.sha256 === sha256) {
  console.log("docs unchanged");
} else {
  writeFileSync(SNAPSHOT, text);
  const meta = { url: URL, fetchedAt: new Date().toISOString(), sha256 };
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
  const operations = docs.services.reduce((n, s) => n + s.operations.length, 0);
  console.log(`docs updated: ${docs.services.length} services, ${operations} operations`);
  console.log("now run: node scripts/generate.ts");
}
