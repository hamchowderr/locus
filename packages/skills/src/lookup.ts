import { readFileSync } from "node:fs";
import { catalog } from "./generated/catalog.ts";
import type { SkillManifest, SkillOperation } from "./index.ts";
import { isReadOperation, POST_READS } from "./reads.ts";

const byId = new Map<string, SkillOperation>(
  catalog.flatMap((skill) => skill.operations.map((op) => [op.id, op] as const)),
);
const byCategory = new Map<string, SkillManifest>(catalog.map((skill) => [skill.category, skill]));

export function operationById(id: string): SkillOperation | undefined {
  return byId.get(id);
}

export function skillByCategory(category: string): SkillManifest | undefined {
  return byCategory.get(category);
}

/** True when the operation only reads from GHL. */
export function isRead(op: SkillOperation): boolean {
  return isReadOperation(op);
}

/** The skill's hand-written guidance plus its generated operation index. */
export function skillDocs(category: string): { skill: string; operations: string } | undefined {
  if (!byCategory.has(category)) return undefined;
  const file = (name: string) =>
    readFileSync(new URL(`../catalog/${category}/${name}`, import.meta.url), "utf8");
  return { skill: file("SKILL.md"), operations: file("operations.md") };
}

export { POST_READS };
