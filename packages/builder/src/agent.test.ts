import { readFile } from "node:fs/promises";
import { useAimock } from "@locus/testing";
import { RequestContext } from "@mastra/core/request-context";
import { afterEach, expect, test } from "vitest";
import {
  createSiteBuilderAgent,
  SITE_BUILDER_INSTRUCTIONS,
  SITE_BUILDER_MODE,
  SITE_BUILDER_OWN_TEXT_TOOLS,
} from "./agent.ts";
import { SKILL_FILES } from "./skills/bundle.generated.ts";
import { readSkillFiles, SKILLS_DIR } from "./skills/files.ts";
import { SITE_BUILDER_SKILL_NAMES, siteBuilderSkills } from "./skills/index.ts";
import { type TestSession, testSession } from "./test-session.ts";
import { createSiteBuilderTools } from "./tools.ts";

const mock = useAimock();
let t: TestSession;
afterEach(() => t?.close());

// Level-1 end to end: AIMock plays the model, so this proves the wiring (Mastra calls the
// builder's tools, they act on the site the host resolved, the results flow back), not the
// model's judgement.
test("the builder writes a page, checks the build and saves a version", async () => {
  t = await testSession();
  mock().llm.on(
    { userMessage: /add an about page/i, hasToolResult: false },
    {
      toolCalls: [
        {
          id: "call_write",
          name: "files",
          arguments: JSON.stringify({
            action: "write",
            path: "app/about/page.tsx",
            content: "export default function About() { return <h1>About</h1>; }\n",
          }),
        },
      ],
    },
  );
  mock().llm.on(
    { toolCallId: "call_write" },
    { toolCalls: [{ id: "call_check", name: "check_site", arguments: "{}" }] },
  );
  mock().llm.on(
    { toolCallId: "call_check" },
    {
      toolCalls: [
        {
          id: "call_save",
          name: "versions",
          arguments: '{"action":"save","message":"Add an about page"}',
        },
      ],
    },
  );
  mock().llm.on({ toolCallId: "call_save" }, { content: "Added an About page." });

  const seen: unknown[] = [];
  const agent = createSiteBuilderAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    resolve: async (requestContext) => {
      seen.push((requestContext as RequestContext).get("siteId"));
      return t.session;
    },
  });
  const requestContext = new RequestContext([["siteId", "site-1"]]);
  const result = await agent.generate("Add an about page", { maxSteps: 6, requestContext });

  expect(result.text).toBe("Added an About page.");
  expect(await t.session.workspace.readFile("app/about/page.tsx")).toContain("About");
  const [version] = await t.session.workspace.listVersions();
  expect(version).toMatchObject({ number: 1, message: "Add an about page", source: "agent" });
  // Every tool call resolved the site from the host's request context.
  expect(seen).toEqual(["site-1", "site-1", "site-1"]);
  expect(t.runtimes.runtimes.get("site-1")?.readText("app/about/page.tsx")).toContain("About");
});

test("the mode exposes every builder tool by name, and the tools match", () => {
  expect(SITE_BUILDER_MODE).toMatchObject({ id: "site-builder", name: "Site builder" });
  expect(SITE_BUILDER_MODE.instructions).toBe(SITE_BUILDER_INSTRUCTIONS);
  expect("additionalTools" in SITE_BUILDER_MODE).toBe(false);
  const tools = createSiteBuilderTools({ resolve: async () => t.session });
  expect([...(SITE_BUILDER_MODE.availableTools ?? [])].sort()).toEqual(Object.keys(tools).sort());
  // The ids the model sees are the record's keys.
  for (const [name, tool] of Object.entries(tools)) expect(tool.id).toBe(name);
});

// Level 1: AIMock decides to load a skill, read one of its files and mistype a name; this
// proves the skill tools answer from the bundled skills and the answers reach the model, not
// that a real model picks the right skill.
test("the builder loads a skill, reads its files, and gets a clean error for an unknown one", async () => {
  t = await testSession();
  mock().llm.on(
    { userMessage: /make it look better/i, hasToolResult: false },
    { toolCalls: [{ id: "call_skill", name: "skill", arguments: '{"name":"impeccable"}' }] },
  );
  mock().llm.on(
    { toolCallId: "call_skill" },
    {
      toolCalls: [
        {
          id: "call_read",
          name: "skill_read",
          arguments: '{"skillName":"shadcn","path":"./rules/forms.md","endLine":3}',
        },
      ],
    },
  );
  mock().llm.on(
    { toolCallId: "call_read" },
    { toolCalls: [{ id: "call_bad", name: "skill", arguments: '{"name":"colours"}' }] },
  );
  mock().llm.on(
    { toolCallId: "call_bad" },
    {
      toolCalls: [
        {
          id: "call_badfile",
          name: "skill_read",
          arguments: '{"skillName":"site-forms","path":"reference/nope.md"}',
        },
      ],
    },
  );
  mock().llm.on({ toolCallId: "call_badfile" }, { content: "Loaded the design skill." });

  let resolved = 0;
  const agent = createSiteBuilderAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    resolve: async () => {
      resolved++;
      return t.session;
    },
  });
  const result = await agent.generate("Make it look better", { maxSteps: 8 });

  expect(result.text).toBe("Loaded the design skill.");
  const outputs = Object.fromEntries(
    result.steps
      .flatMap((step) => step.toolResults)
      .map((r) => [r.payload.toolCallId, r.payload.result]),
  ) as Record<string, Record<string, unknown>>;
  expect(outputs.call_skill).toMatchObject({ name: "impeccable" });
  expect(outputs.call_skill?.instructions).toContain("## How to design");
  expect(outputs.call_skill?.files).toContain("references/reference/craft-floor.md");
  expect(outputs.call_read).toEqual({
    path: "references/rules/forms.md",
    content: "# Forms & Inputs\n\n## Contents",
    lines: expect.stringMatching(/^1-3 of \d+$/),
  });
  expect(outputs.call_bad).toEqual({
    error:
      'There\'s no skill called "colours". Skills: impeccable, shadcn, site-booking, site-forms.',
  });
  expect(outputs.call_badfile?.error).toMatch(/^site-forms has no file reference\/nope\.md/);
  // Skills are the package's own text: loading one never opens the client's site.
  expect(resolved).toBe(0);
  // The catalog is in the (static) instructions the model got.
  const system = JSON.stringify(mock().llm.getRequests().at(-1)?.body);
  expect(system).toContain("- site-forms: Use when adding or changing a form");
});

test("the bundled skills match their sources, parse, and keep their licences", async () => {
  expect(SKILL_FILES).toEqual(await readSkillFiles());
  const skills = siteBuilderSkills();
  expect(skills.map((s) => s.name)).toEqual(SITE_BUILDER_SKILL_NAMES);
  expect(SITE_BUILDER_SKILL_NAMES).toEqual(["impeccable", "shadcn", "site-booking", "site-forms"]);
  for (const name of SITE_BUILDER_SKILL_NAMES) {
    expect(SITE_BUILDER_INSTRUCTIONS).toContain(`- ${name}: `);
  }
  // Vendored skills ship with their licence and are listed with their source.
  const sources = await readFile(new URL("README.md", SKILLS_DIR), "utf8");
  for (const [name, licence] of [
    ["impeccable", "LICENSE"],
    ["shadcn", "LICENSE.md"],
  ] as const) {
    expect(
      (await readFile(new URL(`${name}/${licence}`, SKILLS_DIR), "utf8")).length,
    ).toBeGreaterThan(500);
    expect(sources).toContain(`\`${name}\``);
  }
});

test("the instructions stay the same on every request, and the tools are the mode's", () => {
  expect(SITE_BUILDER_INSTRUCTIONS).not.toMatch(/\$\{|undefined/);
  expect(SITE_BUILDER_MODE.availableTools).toEqual(
    expect.arrayContaining([...SITE_BUILDER_OWN_TEXT_TOOLS]),
  );
});
