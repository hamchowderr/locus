import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhlSession } from "@locus/ghl";
import { createFakeGhl, type FakeGhl, type FakeRoutes, useAimock } from "@locus/testing";
import { LibSQLStore } from "@mastra/libsql";
import { beforeEach, describe, expect, test } from "vitest";
import { createLocusAgent } from "./agent.ts";
import {
  ApprovalError,
  clientResource,
  decideApproval,
  forgetResult,
  NOT_KEPT,
  pendingApprovals,
} from "./conversation.ts";
import { TAINT_MARK } from "./untrusted.ts";

const mock = useAimock();
const clientA: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-A" };
const clientB: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-B" };

beforeEach(() => mock().llm.clearRequests());

/** A fresh client database file per test; each request opens its own store over it. */
function clientDatabase() {
  const url = `file:${join(mkdtempSync(join(tmpdir(), "locus-conv-")), "client.db")}`;
  return () => new LibSQLStore({ id: "client", url });
}

/** One request: a new agent over the same client database, as the API route will build it. */
function request(
  openStore: () => LibSQLStore,
  ghl: FakeGhl,
  options: { session?: GhlSession } = {},
) {
  return createLocusAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    session: options.session ?? clientA,
    fetch: ghl.fetch,
    storage: openStore(),
  });
}

const memory = (thread: string, session: GhlSession = clientA) => ({
  thread,
  resource: clientResource(session),
});

/** Everything the model was sent across all requests, as one string. */
const sentToModel = () =>
  JSON.stringify(
    mock()
      .llm.getRequests()
      .map((r) => r.body),
  );

const perform = (id: string, operation: string, params: unknown) => ({
  toolCalls: [{ id, name: "perform_action", arguments: JSON.stringify({ operation, params }) }],
});

describe("memory", () => {
  test("a later request continues the thread, without the GHL rows it read earlier", async () => {
    mock().llm.on(
      { userMessage: /which forms/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "m1-q",
            name: "query_data",
            arguments: JSON.stringify({
              sources: [{ as: "forms", operation: "forms.get-forms" }],
              sql: "SELECT name FROM forms ORDER BY name",
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "m1-q" }, { content: "Two forms: Contact Us and Quote Request." });
    mock().llm.on({ userMessage: /which was first/i }, { content: "Contact Us, alphabetically." });

    const openStore = clientDatabase();
    const routes: FakeRoutes = {
      "GET /forms/": {
        body: {
          forms: [
            { id: "f1", name: "Quote Request" },
            { id: "f2", name: "Contact Us" },
          ],
        },
      },
    };
    const ghl = createFakeGhl(routes);

    await request(openStore, ghl).generate("Which forms do we have?", {
      maxSteps: 4,
      memory: memory("t-forms"),
    });
    mock().llm.clearRequests();
    const second = await request(openStore, ghl).generate("Which was first?", {
      maxSteps: 4,
      memory: memory("t-forms"),
    });

    expect(second.text).toBe("Contact Us, alphabetically.");
    const followUp = sentToModel();
    // The conversation came back: the earlier question and answer.
    expect(followUp).toContain("Which forms do we have?");
    expect(followUp).toContain("Two forms: Contact Us and Quote Request.");
    // The rows GHL returned did not: only a stub with the row count.
    expect(followUp).toContain(NOT_KEPT);
    expect(followUp).not.toContain('\\"name\\":\\"Quote Request\\"');
    expect(followUp).toContain('\\"rowCount\\":2');

    const stored = await openStore()
      .getStore("memory")
      .then((store) => store?.listMessages({ threadId: "t-forms" }));
    expect(JSON.stringify(stored)).not.toContain('"name":"Quote Request"');
  });

  test("another client cannot read a thread", async () => {
    mock().llm.on({ userMessage: /remember the blue campaign/i }, { content: "Noted." });
    mock().llm.on({ userMessage: /what did i ask you to remember/i }, { content: "Nothing yet." });
    const openStore = clientDatabase();
    const ghl = createFakeGhl({});

    await request(openStore, ghl).generate("Remember the blue campaign", {
      memory: memory("t-shared-id"),
    });
    mock().llm.clearRequests();
    // Same thread id, different client: Mastra refuses a thread owned by another resource.
    await expect(
      request(openStore, ghl, { session: clientB }).generate("What did I ask you to remember?", {
        memory: memory("t-shared-id", clientB),
      }),
    ).rejects.toThrow();
    expect(sentToModel()).not.toContain("blue campaign");
  });

  test("conversations need a client session", () => {
    expect(() => clientResource({ token: "t", tokenKind: "agency", companyId: "co" })).toThrow();
  });
});

describe("approvals across requests", () => {
  function scriptDeletion(prefix: string) {
    mock().llm.on(
      { userMessage: new RegExp(`delete ${prefix}`, "i"), hasToolResult: false },
      perform(`${prefix}-del`, "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
  }

  async function suspendDeletion(prefix: string, openStore: () => LibSQLStore, ghl: FakeGhl) {
    const first = await request(openStore, ghl).generate(`Delete ${prefix} contact c1`, {
      maxSteps: 4,
      memory: memory(`t-${prefix}`),
    });
    expect(first.finishReason).toBe("suspended");
    expect(ghl.requests).toEqual([]);
  }

  test("a deletion waits, a later request lists it, and approving it sends it", async () => {
    scriptDeletion("a1");
    mock().llm.on({ toolCallId: "a1-del" }, { content: "Deleted contact c1." });
    const openStore = clientDatabase();
    const ghl = createFakeGhl({ "DELETE /contacts/c1": { body: { succeded: true } } });
    await suspendDeletion("a1", openStore, ghl);

    const later = request(openStore, ghl);
    const pending = await pendingApprovals(later, clientA, "t-a1");
    expect(pending).toEqual([
      {
        runId: expect.any(String),
        toolCallId: "a1-del",
        toolName: "perform_action",
        args: { operation: "contacts.delete-contact", params: { path: { contactId: "c1" } } },
      },
    ]);

    const result = await decideApproval(later, clientA, {
      threadId: "t-a1",
      toolCallId: "a1-del",
      approve: true,
    });

    expect(result.text).toBe("Deleted contact c1.");
    expect(ghl.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "DELETE /contacts/c1",
    ]);
    expect(await pendingApprovals(later, clientA, "t-a1")).toEqual([]);
  });

  test("declining sends nothing and tells the model why", async () => {
    scriptDeletion("a2");
    mock().llm.on(
      { toolCallId: "a2-del", toolResultContains: "keep this one" },
      { content: "Okay, I left contact c1 alone." },
    );
    const openStore = clientDatabase();
    const ghl = createFakeGhl({ "*": { body: {} } });
    await suspendDeletion("a2", openStore, ghl);

    const result = await decideApproval(request(openStore, ghl), clientA, {
      threadId: "t-a2",
      toolCallId: "a2-del",
      approve: false,
      reason: "keep this one, they are a client",
    });

    expect(result.text).toBe("Okay, I left contact c1 alone.");
    expect(ghl.requests).toEqual([]);
  });

  test("a run waiting for approval keeps no GHL data while it waits", async () => {
    mock().llm.on(
      { userMessage: /delete the old promo/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "a6-read",
            name: "query_data",
            arguments: JSON.stringify({
              sources: [{ as: "forms", operation: "forms.get-forms" }],
              sql: "SELECT id, name FROM forms",
            }),
          },
        ],
      },
    );
    mock().llm.on(
      { toolCallId: "a6-read" },
      perform("a6-del", "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
    mock().llm.on({ userMessage: /anything else/i }, { content: "No." });
    const openStore = clientDatabase();
    const ghl = createFakeGhl({
      "GET /forms/": { body: { forms: [{ id: "f1", name: "Secret Promo Form" }] } },
    });

    const first = await request(openStore, ghl).generate("Delete the old promo", {
      maxSteps: 4,
      memory: memory("t-a6"),
    });
    expect(first.finishReason).toBe("suspended");

    const stored = await openStore()
      .getStore("memory")
      .then((store) => store?.listMessages({ threadId: "t-a6" }));
    expect(JSON.stringify(stored)).toContain(NOT_KEPT);
    expect(JSON.stringify(stored)).not.toContain("Secret Promo Form");
    // Nor does the next turn on the thread, while the deletion is still undecided.
    mock().llm.clearRequests();
    await request(openStore, ghl).generate("Anything else?", { memory: memory("t-a6") });
    expect(sentToModel()).not.toContain("Secret Promo Form");
  });

  test("only the client whose thread it is can see or decide a pending change", async () => {
    scriptDeletion("a3");
    const openStore = clientDatabase();
    const ghl = createFakeGhl({ "*": { body: {} } });
    await suspendDeletion("a3", openStore, ghl);

    const other = request(openStore, ghl, { session: clientB });
    expect(await pendingApprovals(other, clientB, "t-a3")).toEqual([]);
    await expect(
      decideApproval(other, clientB, { threadId: "t-a3", toolCallId: "a3-del", approve: true }),
    ).rejects.toBeInstanceOf(ApprovalError);
    // Nor can the right client decide something that is not pending.
    await expect(
      decideApproval(request(openStore, ghl), clientA, {
        threadId: "t-a3",
        toolCallId: "made-up",
        approve: true,
      }),
    ).rejects.toBeInstanceOf(ApprovalError);
    expect(ghl.requests).toEqual([]);
  });

  test("a tainted run is still tainted when it resumes in a later request", async () => {
    mock().llm.on(
      { userMessage: /tag today's leads/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "a4-read",
            name: "query_data",
            arguments: JSON.stringify({
              sources: [{ as: "subs", operation: "forms.get-forms-submissions" }],
              sql: "SELECT contactId FROM subs",
            }),
          },
        ],
      },
    );
    mock().llm.on(
      { toolCallId: "a4-read" },
      perform("a4-tag1", "contacts.add-tags", { path: { contactId: "c1" }, body: { tags: ["x"] } }),
    );
    mock().llm.on(
      { toolCallId: "a4-tag1" },
      perform("a4-tag2", "contacts.add-tags", { path: { contactId: "c2" }, body: { tags: ["x"] } }),
    );
    const openStore = clientDatabase();
    const ghl = createFakeGhl({
      "GET /forms/submissions": { body: { submissions: [{ id: "s1", contactId: "c1" }] } },
      "*": { status: 201, body: {} },
    });

    const first = await request(openStore, ghl).generate("Tag today's leads", {
      maxSteps: 6,
      memory: memory("t-a4"),
    });
    // Reading submissions tainted the run, so even adding a tag waits.
    expect(first.finishReason).toBe("suspended");

    const result = await decideApproval(request(openStore, ghl), clientA, {
      threadId: "t-a4",
      toolCallId: "a4-tag1",
      approve: true,
    });

    // The resumed run, in a new request with a fresh agent, still knows it read public text.
    expect(result.finishReason).toBe("suspended");
    expect(result.suspendPayload).toMatchObject({ toolCallId: "a4-tag2" });
    expect(ghl.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /forms/submissions",
      "POST /contacts/c1/tags",
    ]);
  });

  test("an approved clean run carries on without asking again", async () => {
    scriptDeletion("a5");
    mock().llm.on(
      { toolCallId: "a5-del" },
      perform("a5-tag", "contacts.add-tags", { path: { contactId: "c2" }, body: { tags: ["x"] } }),
    );
    mock().llm.on({ toolCallId: "a5-tag" }, { content: "Deleted c1 and tagged c2." });
    const openStore = clientDatabase();
    const ghl = createFakeGhl({ "*": { status: 200, body: {} } });
    await suspendDeletion("a5", openStore, ghl);

    const result = await decideApproval(request(openStore, ghl), clientA, {
      threadId: "t-a5",
      toolCallId: "a5-del",
      approve: true,
    });

    expect(result.text).toBe("Deleted c1 and tagged c2.");
    expect(ghl.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "DELETE /contacts/c1",
      "POST /contacts/c2/tags",
    ]);
  });
});

describe("forgetResult", () => {
  test("keeps our own text, drops GHL data and what GHL errors said", () => {
    const skill = { skill: "# Forms", operations: "…" };
    expect(forgetResult("load_skill", skill)).toBe(skill);
    // Another feature's tool is forgotten too, unless it says its results hold no GHL data.
    const file = { path: "app/page.tsx", content: "…" };
    expect(forgetResult("read_file", file)).toEqual({ notKept: expect.any(String) });
    expect(forgetResult("read_file", file, { keep: ["read_file"] })).toBe(file);
    // A GHL error can quote data back ("a contact with ann@example.com already exists").
    expect(
      forgetResult("perform_action", { error: "contacts.x: 400 ann@example.com exists" }),
    ).toEqual({ notKept: NOT_KEPT, failed: true });
    expect(forgetResult("perform_action", { contact: { id: "c1", email: "a@b.c" } })).toEqual({
      notKept: NOT_KEPT,
    });
    expect(forgetResult("query_data", { columns: ["n"], rows: [{ n: 1 }], rowCount: 1 })).toEqual({
      notKept: NOT_KEPT,
      rowCount: 1,
    });
    // A result the untrusted-content screen wrapped is unwrapped first.
    expect(
      forgetResult("query_data", { warning: "1 withheld", result: { rows: [], rowCount: 0 } }),
    ).toEqual({ notKept: NOT_KEPT, rowCount: 0 });
    // A paused run keeps the taint mark so it is still tainted when it resumes.
    const tainted = { warning: "w", taint: TAINT_MARK, result: { rows: [], rowCount: 0 } };
    expect(forgetResult("query_data", tainted, { keepTaint: true })).toEqual({
      notKept: NOT_KEPT,
      rowCount: 0,
      taint: TAINT_MARK,
    });
    expect(forgetResult("query_data", tainted)).toEqual({ notKept: NOT_KEPT, rowCount: 0 });
  });
});
