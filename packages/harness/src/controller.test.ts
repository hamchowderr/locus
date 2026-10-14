import type { GhlSession } from "@locus/ghl";
import { createFakeGhl, type FakeGhl, type FakeRoutes, useAimock } from "@locus/testing";
import type { AgentController } from "@mastra/core/agent-controller";
import { LibSQLStore } from "@mastra/libsql";
import { beforeEach, describe, expect, test } from "vitest";
import { createLocusController, openClientSession } from "./controller.ts";
import { NOT_KEPT } from "./conversation.ts";

const mock = useAimock();
const clientA: GhlSession = { token: "tok-A", tokenKind: "location", locationId: "loc-A" };

beforeEach(() => mock().llm.clearRequests());

type Session = Awaited<ReturnType<typeof openClientSession>>;

async function controllerFor(
  routes: FakeRoutes,
  session: () => Promise<GhlSession> = async () => clientA,
) {
  const ghl = createFakeGhl(routes);
  const storage = new LibSQLStore({ id: "client", url: ":memory:" });
  const controller = await createLocusController({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    locationId: "loc-A",
    session,
    storage,
    fetch: ghl.fetch,
  });
  return { ghl, controller, storage };
}

/**
 * Sends one message and answers every approval with `decide`. Returns what happened, in order.
 */
async function send(
  session: Session,
  content: string,
  decide: (toolCallId: string) => "approve" | "decline" = () => "approve",
) {
  const seen: string[] = [];
  const stop = session.subscribe((event) => {
    if (event.type === "tool_approval_required") {
      seen.push(`approval:${event.toolCallId}`);
      const decision = decide(event.toolCallId);
      // Answer after the gate is armed, as a person clicking in the chat would.
      setTimeout(
        () => session.respondToToolApproval({ decision, toolCallId: event.toolCallId }),
        0,
      );
    }
    if (event.type === "error") seen.push(`error:${String(event.error)}`);
  });
  try {
    await session.sendMessage({ content });
  } finally {
    stop();
  }
  return seen;
}

const sent = (ghl: FakeGhl) => ghl.requests.map((r) => `${r.method} ${r.url.pathname}`);

const perform = (id: string, operation: string, params: unknown) => ({
  toolCalls: [{ id, name: "perform_action", arguments: JSON.stringify({ operation, params }) }],
});
const read = (id: string, operation: string, sql: string) => ({
  toolCalls: [
    {
      id,
      name: "query_data",
      arguments: JSON.stringify({ sources: [{ as: "t", operation }], sql }),
    },
  ],
});
const tagC1 = { path: { contactId: "c1" }, body: { tags: ["vip"] } };

/** Names of the tools offered to the model in its most recent request. */
function toolsOffered(): string[] {
  const last = mock().llm.getRequests().at(-1)?.body as {
    tools?: { name?: string; function?: { name?: string } }[];
  };
  return (last?.tools ?? []).map((t) => t.name ?? t.function?.name ?? "");
}

describe("act mode", () => {
  test("ordinary writes go through; a deletion waits for the person's approval", async () => {
    mock().llm.on(
      { userMessage: /c1: tag then delete/i, hasToolResult: false },
      perform("c1-tag", "contacts.add-tags", tagC1),
    );
    mock().llm.on(
      { toolCallId: "c1-tag" },
      perform("c1-del", "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
    mock().llm.on({ toolCallId: "c1-del" }, { content: "Tagged and deleted c1." });
    const { ghl, controller } = await controllerFor({ "*": { body: {} } });
    const session = await openClientSession(controller, { memberId: "m1" });

    const seen = await send(session, "c1: tag then delete");

    expect(seen).toEqual(["approval:c1-del"]);
    expect(sent(ghl)).toEqual(["POST /contacts/c1/tags", "DELETE /contacts/c1"]);
    // Every request carried the client's own token.
    expect(ghl.requests.every((r) => r.headers.authorization === "Bearer tok-A")).toBe(true);
  });

  test("a declined deletion sends nothing", async () => {
    mock().llm.on(
      { userMessage: /c2: delete/i, hasToolResult: false },
      perform("c2-del", "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
    mock().llm.on({ toolCallId: "c2-del" }, { content: "Okay, I won't." });
    const { ghl, controller } = await controllerFor({ "*": { body: {} } });
    const session = await openClientSession(controller, { memberId: "m1" });

    await send(session, "c2: delete c1", () => "decline");

    expect(sent(ghl)).toEqual([]);
  });

  test("'always allow' approves that one deletion, never the next", async () => {
    mock().llm.on(
      { userMessage: /c8: delete c1/i, hasToolResult: false },
      perform("c8-del1", "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
    mock().llm.on({ toolCallId: "c8-del1" }, { content: "Deleted c1." });
    mock().llm.on(
      { userMessage: /c8: delete c2/i, hasToolResult: false },
      perform("c8-del2", "contacts.delete-contact", { path: { contactId: "c2" } }),
    );
    mock().llm.on({ toolCallId: "c8-del2" }, { content: "Deleted c2." });
    const { ghl, controller } = await controllerFor({ "*": { body: {} } });
    const session = await openClientSession(controller, { memberId: "m1" });

    const answer = (id: string) => {
      setTimeout(
        () => session.respondToToolApproval({ decision: "always_allow_category", toolCallId: id }),
        0,
      );
    };
    const seen: string[] = [];
    const stop = session.subscribe((event) => {
      if (event.type !== "tool_approval_required") return;
      seen.push(event.toolCallId);
      answer(event.toolCallId);
    });
    await session.sendMessage({ content: "c8: delete c1" });
    await session.sendMessage({ content: "c8: delete c2" });
    stop();

    expect(seen).toEqual(["c8-del1", "c8-del2"]);
    expect(sent(ghl)).toEqual(["DELETE /contacts/c1", "DELETE /contacts/c2"]);
  });

  test("after reading public text, even a tag waits, and the next run starts clean", async () => {
    mock().llm.on(
      { userMessage: /c3: summarise submissions/i, hasToolResult: false },
      read("c3-read", "forms.get-forms-submissions", "SELECT name FROM t"),
    );
    mock().llm.on({ toolCallId: "c3-read" }, perform("c3-tag", "contacts.add-tags", tagC1));
    // After the approval the run resumes, still tainted: the next tag asks again.
    mock().llm.on({ toolCallId: "c3-tag" }, perform("c3-tag-b", "contacts.add-tags", tagC1));
    mock().llm.on({ toolCallId: "c3-tag-b" }, { content: "Tagged." });
    mock().llm.on(
      { userMessage: /c3: now tag c1/i, hasToolResult: false },
      perform("c3-tag2", "contacts.add-tags", tagC1),
    );
    mock().llm.on({ toolCallId: "c3-tag2" }, { content: "Tagged again." });
    const { ghl, controller } = await controllerFor({
      "GET /forms/submissions": { body: { submissions: [{ id: "s1", name: "Ann" }] } },
      "*": { body: {} },
    });
    const session = await openClientSession(controller, { memberId: "m1" });

    expect(await send(session, "c3: summarise submissions and tag")).toEqual([
      "approval:c3-tag",
      "approval:c3-tag-b",
    ]);
    // Same session, same thread, a new run: the taint was that run's alone.
    expect(await send(session, "c3: now tag c1")).toEqual([]);
    expect(sent(ghl)).toEqual([
      "GET /forms/submissions",
      "POST /contacts/c1/tags",
      "POST /contacts/c1/tags",
      "POST /contacts/c1/tags",
    ]);
  });
});

describe("ask mode", () => {
  test("only reads are offered", async () => {
    mock().llm.on({ userMessage: /c4: how many forms/i }, { content: "I can check that." });
    const { controller } = await controllerFor({});
    const session = await openClientSession(controller, { memberId: "m1" });
    await session.mode.switch({ modeId: "ask" });

    await send(session, "c4: how many forms?");

    const offered = toolsOffered();
    expect(offered).toContain("query_data");
    expect(offered).not.toContain("perform_action");
  });
});

describe("the controller's client", () => {
  test("a token for another client is refused before anything is sent", async () => {
    mock().llm.on(
      { userMessage: /c5: tag/i, hasToolResult: false },
      perform("c5-tag", "contacts.add-tags", tagC1),
    );
    mock().llm.on({ toolCallId: "c5-tag" }, { content: "Could not." });
    const { ghl, controller } = await controllerFor({ "*": { body: {} } }, async () => ({
      token: "tok-B",
      tokenKind: "location",
      locationId: "loc-B",
    }));
    const session = await openClientSession(controller, { memberId: "m1" });

    await send(session, "c5: tag c1");

    expect(sent(ghl)).toEqual([]);
  });

  test("threads belong to the client and keep no GHL rows", async () => {
    mock().llm.on(
      { userMessage: /c6: list forms/i, hasToolResult: false },
      read("c6-read", "forms.get-forms", "SELECT name FROM t"),
    );
    mock().llm.on({ toolCallId: "c6-read" }, { content: "One form." });
    const { controller, storage } = await controllerFor({
      "GET /forms/": { body: { forms: [{ id: "f1", name: "Secret Promo Form" }] } },
    });
    const session = await openClientSession(controller, { memberId: "m1" });

    await send(session, "c6: list forms");

    const threads = await controller.queryThreads({});
    expect(threads.map((t) => t.resourceId)).toEqual(["client:loc-A"]);
    const memory = await storage.getStore("memory");
    const stored = JSON.stringify(await memory?.listMessages({ threadId: threads[0]?.id ?? "" }));
    expect(stored).toContain("c6: list forms");
    expect(stored).toContain(NOT_KEPT);
    expect(stored).not.toContain("Secret Promo Form");
  });

  test("planning and subagent tools are off: the GHL agent has no workspace", async () => {
    mock().llm.on({ userMessage: /c7: hello/i }, { content: "Hi." });
    const { controller } = await controllerFor({});
    const session = await openClientSession(controller, { memberId: "m1" });

    await send(session, "c7: hello");

    const offered = toolsOffered();
    expect(offered).toEqual(expect.arrayContaining(["load_skill", "query_data", "perform_action"]));
    expect(offered).not.toContain("submit_plan");
    expect(offered).not.toContain("subagent");
  });

  test("two members get separate live sessions on the same client", async () => {
    const { controller } = await controllerFor({});
    const a = await openClientSession(controller, { memberId: "m1" });
    const b = await openClientSession(controller, { memberId: "m2" });
    expect(a).not.toBe(b);
    expect(await openClientSession(controller, { memberId: "m1" })).toBe(a);
  });

  test("only a Locus controller opens client sessions", async () => {
    await expect(openClientSession({} as AgentController, { memberId: "m1" })).rejects.toThrow(
      "not a Locus controller",
    );
  });
});
