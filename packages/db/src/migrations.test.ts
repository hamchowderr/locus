import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import { CONTROL_MIGRATIONS, TENANT_MIGRATIONS } from "./client.ts";
import * as control from "./control/index.ts";
import * as tenant from "./tenant/index.ts";

/** The newest snapshot drizzle-kit wrote. Custom (SQL-only) migrations repeat the previous one. */
function latestSnapshot(folder: string) {
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));
  const last = journal.entries.at(-1);
  const file = join(folder, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("migrations match the schema", () => {
  it.each([
    ["control", control, CONTROL_MIGRATIONS],
    ["tenant", tenant, TENANT_MIGRATIONS],
  ])(
    "%s: no change is missing a migration (run `pnpm --filter @locus/db generate`)",
    async (_, schema, folder) => {
      const prev = latestSnapshot(folder);
      const cur = await generateSQLiteDrizzleJson(schema as Record<string, unknown>, prev.id);
      expect(await generateSQLiteMigration(prev, cur)).toEqual([]);
    },
  );
});
