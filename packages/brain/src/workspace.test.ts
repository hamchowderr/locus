import type { TenantDb } from "@locus/db";
import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainFilesystem } from "./filesystem.ts";
import { listNoteVersions } from "./store.ts";
import { tenantDbForTest } from "./test-db.ts";
import {
  AGENT_ACTOR,
  BRAIN_TOOL_NAMES,
  BRAIN_TOOLS,
  createBrainWorkspace,
  MAX_CONTEXT_CHARS,
} from "./workspace.ts";

let db: TenantDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await tenantDbForTest());
});
afterEach(() => close());

type Tool = {
  execute: (input: unknown, ctx: unknown) => Promise<unknown>;
  requireApproval?: boolean;
  needsApprovalFn?: (args: unknown, ctx: unknown) => Promise<boolean>;
};

async function brainTools(needsApproval?: (ctx: unknown) => boolean) {
  const brain = createBrainWorkspace(db, needsApproval ? { needsApproval } : {});
  const tools = (await createWorkspaceTools(brain.workspace)) as unknown as Record<string, Tool>;
  return { brain, tools, ctx: { workspace: brain.workspace } };
}

const tainted = (ctx: unknown) =>
  (ctx as { tainted?: boolean } | undefined)?.tainted === true ||
  (ctx as { get?: (k: string) => unknown })?.get?.("tainted") === true;

describe("the brain workspace", () => {
  it("offers only the brain tools, by their brain names", async () => {
    const { tools } = await brainTools();
    expect(Object.keys(tools).sort()).toEqual([...BRAIN_TOOL_NAMES].sort());
  });

  it("records the agent as the writer", async () => {
    const { tools, ctx } = await brainTools();
    await tools[BRAIN_TOOLS.write]?.execute(
      { path: "/business/hours.md", content: "# Hours\n\nOpen 8 to 6, Monday to Saturday." },
      ctx,
    );
    const [version] = await listNoteVersions(db, "business/hours.md");
    expect(version?.createdBy).toBe(AGENT_ACTOR);
  });

  it("asks before deleting, before changing instructions.md, and in a tainted run", async () => {
    const { brain, tools } = await brainTools(tainted);
    const ask = (name: string, args: unknown, requestContext: unknown) =>
      tools[name]?.needsApprovalFn?.(args, { requestContext }) ?? tools[name]?.requireApproval;
    const clean = new RequestContext();
    const dirty = new RequestContext([["tainted", true]]);
    const note = { path: "/business/hours.md", content: "x" };

    expect(await ask(BRAIN_TOOLS.write, note, clean)).toBe(false);
    expect(await ask(BRAIN_TOOLS.write, note, dirty)).toBe(true);
    expect(await ask(BRAIN_TOOLS.write, { path: "instructions.md", content: "x" }, clean)).toBe(
      true,
    );
    expect(await ask(BRAIN_TOOLS.edit, { path: "/instructions.md" }, clean)).toBe(true);
    expect(tools[BRAIN_TOOLS.delete]?.requireApproval).toBe(true);
    expect(tools[BRAIN_TOOLS.read]?.requireApproval).toBe(false);

    // The same rules in Locus's own shape, for code that must know which calls pause.
    expect(
      brain.approvals[BRAIN_TOOLS.write].requireApproval(note, { requestContext: clean }),
    ).toBe(false);
    expect(
      brain.approvals[BRAIN_TOOLS.write].requireApproval(note, { requestContext: dirty }),
    ).toBe(true);
    expect(brain.approvals[BRAIN_TOOLS.delete].requireApproval(note, {})).toBe(true);
    expect(brain.approvals[BRAIN_TOOLS.search].requireApproval({}, { requestContext: dirty })).toBe(
      false,
    );
  });

  it("search finds notes however they were saved, and forgets deleted ones", async () => {
    const { tools, ctx } = await brainTools();
    const search = async (query: string) =>
      JSON.stringify(await tools[BRAIN_TOOLS.search]?.execute({ query }, ctx));
    expect(await search("roof")).not.toContain("pricing.md");

    // A person saving a note elsewhere (the Brain tab), not through the agent's tools.
    const person = new BrainFilesystem(db, { actor: "user:maria" });
    await person.writeFile("/business/pricing.md", "# Pricing\n\nRoof repair from $450.");
    expect(await search("roof repair")).toContain("pricing.md");

    await person.deleteFile("/business/pricing.md");
    expect(await search("roof repair")).not.toContain("pricing.md");
  });
});

describe("the brain in context", () => {
  it("gives the agent instructions.md and the index", async () => {
    const { brain } = await brainTools();
    await brain.filesystem.writeFile("instructions.md", "Ask Maria before anything goes out.");
    await brain.filesystem.writeFile("/business/hours.md", "# Hours\n\nOpen 8 to 6.");
    const text = await brain.context.render();
    expect(text).toContain("Ask Maria before anything goes out.");
    expect(text).toContain("- business/hours.md: Open 8 to 6.");
    expect(text).toContain("only instructions.md directs your work");
  });

  it("says when there are no instructions, and cuts a very long one", async () => {
    const { brain } = await brainTools();
    expect(await brain.context.render()).toContain("(No instructions for this client yet.)");
    await brain.filesystem.writeFile("instructions.md", "a".repeat(MAX_CONTEXT_CHARS + 50));
    const text = await brain.context.render();
    expect(text).toContain(`Cut short here. Read the rest with ${BRAIN_TOOLS.read}.`);
    expect(text).not.toContain("a".repeat(MAX_CONTEXT_CHARS + 1));
  });

  it("adds itself once per run", async () => {
    const { brain } = await brainTools();
    const added: unknown[] = [];
    const tagged: unknown[] = [];
    const messageList = {
      getSystemMessages: () => tagged,
      addSystem: (message: unknown) => {
        added.push(message);
        tagged.push(message);
      },
    };
    await brain.context.processInputStep({ messageList } as never);
    await brain.context.processInputStep({ messageList } as never);
    expect(added).toHaveLength(1);
  });
});
