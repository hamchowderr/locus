import {
  createSkill,
  type InlineSkill,
  resolveAgentSkills,
  validateSkillContent,
  type WorkspaceSkills,
} from "@mastra/core/skills";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SKILL_FILES } from "./bundle.generated.ts";

/**
 * The builder's Agent Skills (SKILL.md format), parsed and served with Mastra's own skills
 * support (`createSkill`, `resolveAgentSkills`): the instructions list each skill's name and
 * description, and the agent loads one with `skill` and reads its files with `skill_read`.
 *
 * Sources are in packages/builder/skills/ (third-party skills vendored with their licences,
 * plus Locus's own); `scripts/bundle-skills.ts` bundles their text into the package, so nothing
 * is read from disk at run time. A skill's linked files (e.g. `reference/craft-floor.md`) are
 * read with `skill_read` by the path the skill gives.
 */

/**
 * A skill from its files. The SKILL.md frontmatter (YAML, folded and multi-line values
 * included) is parsed and checked by Mastra's own `validateSkillContent`, the rules it applies
 * when it loads skills; fields outside the Agent Skills spec are not kept.
 */
function parseSkill(name: string, files: Record<string, string>): InlineSkill {
  const raw = files["SKILL.md"];
  if (raw === undefined) throw new Error(`skill ${name} has no SKILL.md`);
  const parsed = validateSkillContent({ content: raw, directoryName: name });
  if (!parsed.valid || !parsed.metadata || parsed.instructions === undefined) {
    throw new Error(`skill ${name}'s SKILL.md is invalid: ${parsed.errors.join("; ")}`);
  }
  const { description, license, "user-invocable": invocable, metadata } = parsed.metadata;
  const references = Object.fromEntries(
    Object.entries(files).filter(([path]) => path !== "SKILL.md"),
  );
  return createSkill({
    name,
    description: String(description).trim(),
    instructions: parsed.instructions,
    ...(typeof license === "string" ? { license } : {}),
    ...(typeof invocable === "boolean" ? { "user-invocable": invocable } : {}),
    ...(metadata && typeof metadata === "object"
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
    references,
  });
}

let skills: InlineSkill[] | undefined;

/** Every builder skill, parsed once. */
export function siteBuilderSkills(): InlineSkill[] {
  skills ??= Object.entries(SKILL_FILES).map(([name, files]) => parseSkill(name, files));
  return skills;
}

/** The skill names, for instructions and tests. */
export const SITE_BUILDER_SKILL_NAMES = Object.keys(SKILL_FILES);

/**
 * One line per skill (name: description), for the builder's instructions. Static, so the
 * instructions still cache.
 */
export const SKILL_CATALOG = siteBuilderSkills()
  .map((skill) => `- ${skill.name}: ${skill.description}`)
  .join("\n");

let store: WorkspaceSkills | undefined;
/** The skills as Mastra's skill store (the one its own skill tools read). */
const skillStore = () => {
  store ??= resolveAgentSkills(siteBuilderSkills());
  return store;
};

/** A path as written in a skill (`reference/x.md`, `./rules/y.md`) → its place in the store. */
const referencePath = (path: string) => {
  const clean = path.trim().replace(/^\.?\//, "");
  return clean.startsWith("references/") ? clean : `references/${clean}`;
};

/**
 * `skill` and `skill_read`, with the names and behaviour of Mastra's own skill tools, served
 * from Mastra's skill store. The builder ships them as its own tools rather than through an
 * agent's `skills` because inside an AgentController Mastra's tools wait for a person's
 * approval (they decide nothing for themselves), and @mastra/core 1.75 resumes an approved run
 * without the mode's tool allowlist. These decide for themselves: they only read Locus's text.
 */
export function createSkillTools() {
  const skill = createTool({
    id: "skill",
    description:
      "Load a skill's full instructions by name, with the list of its files. Load the skills " +
      "a task needs before building.",
    requireApproval: noApproval,
    inputSchema: z.object({ name: z.string().min(1).max(100) }),
    execute: async ({ name }: { name: string }) => {
      const found = await skillStore().get(name.trim());
      if (!found) return { error: notFound(name) };
      const files = (found.references ?? []).map((r) => `references/${r}`);
      return {
        name: found.name,
        instructions: found.instructions,
        ...(files.length > 0 ? { files } : {}),
      };
    },
  });

  const skill_read = createTool({
    id: "skill_read",
    description:
      "Read one of a skill's files (a reference it links to, e.g. reference/craft-floor.md or " +
      "rules/forms.md), optionally only some lines.",
    requireApproval: noApproval,
    inputSchema: z.object({
      skillName: z.string().min(1).max(100),
      path: z.string().min(1).max(300),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    execute: async (input: {
      skillName: string;
      path: string;
      startLine?: number | undefined;
      endLine?: number | undefined;
    }) => {
      const found = await skillStore().get(input.skillName.trim());
      if (!found) return { error: notFound(input.skillName) };
      const path = referencePath(input.path);
      const text = await skillStore().getReference(found.path, path);
      if (typeof text !== "string") {
        return {
          error:
            `${input.skillName} has no file ${input.path}. Its files: ` +
            (found.references ?? []).map((r) => `references/${r}`).join(", "),
        };
      }
      const lines = text.split("\n");
      const from = (input.startLine ?? 1) - 1;
      const to = input.endLine ?? lines.length;
      return {
        path,
        content: lines.slice(from, to).join("\n"),
        ...(from > 0 || to < lines.length
          ? { lines: `${from + 1}-${Math.min(to, lines.length)} of ${lines.length}` }
          : {}),
      };
    },
  });

  return { skill, skill_read };
}

const noApproval = () => false;

const notFound = (name: string) =>
  `There's no skill called "${name}". Skills: ${SITE_BUILDER_SKILL_NAMES.join(", ")}.`;
