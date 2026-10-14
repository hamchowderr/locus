import type { GhlSession } from "@locus/ghl";
import { createLocusController } from "@locus/harness";
import { createFakeGhl, type FakeGhl, useAimock } from "@locus/testing";
import { MastraClient } from "@mastra/client-js";
import type { AgentController } from "@mastra/core/agent-controller";
import { LibSQLStore } from "@mastra/libsql";
import { beforeEach, describe, expect, test } from "vitest";
import { type AgentApiMember, createAgentApi } from "./index.ts";

const mock = useAimock();
beforeEach(() => mock().llm.clearRequests());

const PREFIX = "/api/agent";
const RESOURCE = "client:loc-A";

/** The API over one fake client, with the member each request is signed in as. */
function apiFor(ghl: FakeGhl) {
  let signedIn: AgentApiMember | null = { memberId: "m1", locationId: "loc-A" };
  let controller: AgentController | undefined;
  const api = createAgentApi({
    prefix: PREFIX,
    authorize: async () => signedIn,
    controllerFor: async (locationId) => {
      controller = await createLocusController({
        model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
        locationId,
        session: async (): Promise<GhlSession> => ({
          token: "tok-A",
          tokenKind: "location",
          locationId,
        }),
        storage: new LibSQLStore({ id: "client", url: ":memory:" }),
        fetch: ghl.fetch,
      });
      return controller;
    },
  });
  const client = new MastraClient({
    baseUrl: "http://locus.test",
    apiPrefix: PREFIX,
    retries: 0,
    fetch: (input, init) => api.fetch(new Request(input, init)),
  });
  return {
    api,
    client,
    controller: () => controller as AgentController,
    signIn: (member: AgentApiMember | null) => {
      signedIn = member;
    },
  };
}

const perform = (id: string, operation: string, params: unknown) => ({
  toolCalls: [{ id, name: "perform_action", arguments: JSON.stringify({ operation, params }) }],
});

/** Collects a session's events until `until` matches one, or fails after a while. */
async function watch(
  session: ReturnType<ReturnType<MastraClient["getAgentController"]>["session"]>,
) {
  const events: { type: string; [key: string]: unknown }[] = [];
  const waiters: { match: (e: (typeof events)[number]) => boolean; done: () => void }[] = [];
  const subscription = await session.subscribe({
    onEvent: (event) => {
      const e = event as (typeof events)[number];
      events.push(e);
      for (const w of waiters.filter((w) => w.match(e))) w.done();
    },
  });
  const next = (match: (e: (typeof events)[number]) => boolean) =>
    events.find(match) ??
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event never came")), 5_000);
      waiters.push({
        match,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  return { events, next, stop: () => subscription.unsubscribe() };
}

describe("the chat, through the agent API", () => {
  test("a deletion waits for the member, and goes through when they approve it", async () => {
    mock().llm.on(
      { userMessage: /delete contact c1/i, hasToolResult: false },
      perform("x1-del", "contacts.delete-contact", { path: { contactId: "c1" } }),
    );
    mock().llm.on({ toolCallId: "x1-del" }, { content: "Deleted c1." });
    const ghl = createFakeGhl({ "*": { body: {} } });
    const { client } = apiFor(ghl);
    const session = client.getAgentController("locus").session(RESOURCE);
    await session.create();
    const stream = await watch(session);

    await session.sendMessage("Delete contact c1");
    await stream.next((e) => e.type === "tool_approval_required");
    expect(ghl.requests).toEqual([]);

    await session.approveTool("x1-del", true);
    await stream.next((e) => e.type === "agent_end");
    stream.stop();

    expect(ghl.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "DELETE /contacts/c1",
    ]);
  });
});

describe("the guard", () => {
  const ghl = createFakeGhl({ "*": { body: {} } });

  test("nobody signed in gets 401", async () => {
    const { api, signIn } = apiFor(ghl);
    signIn(null);
    const res = await api.fetch(
      new Request(`http://locus.test${PREFIX}/agent-controller/locus/modes`),
    );
    expect(res.status).toBe(401);
  });

  test("another client's resource is refused, in the path and in the body", async () => {
    const { api } = apiFor(ghl);
    const other = encodeURIComponent("client:loc-B");
    const state = await api.fetch(
      new Request(`http://locus.test${PREFIX}/agent-controller/locus/sessions/${other}`),
    );
    expect(state.status).toBe(403);
    const create = await api.fetch(
      new Request(`http://locus.test${PREFIX}/agent-controller/locus/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceId: "client:loc-B" }),
      }),
    );
    expect(create.status).toBe(403);
  });

  test("routes that would change what needs approval are not served", async () => {
    const { client } = apiFor(ghl);
    const session = client.getAgentController("locus").session(RESOURCE);
    await session.create();
    const refused = [
      () => session.setState({ yolo: true }),
      () => session.setPermissionForCategory("other", "allow"),
      () => session.setPermissionForTool("perform_action", "allow"),
      () => session.switchModel("anthropic/claude-other"),
      () => session.setResourceId("client:loc-B"),
      () => session.getResourceIds(),
      () => client.getAgentController("locus").listActiveRuns(),
    ];
    for (const call of refused) await expect(call()).rejects.toThrow(/404/);
  });

  test("each member gets their own live session; pending changes belong to the client", async () => {
    mock().llm.on(
      { userMessage: /delete contact c2/i, hasToolResult: false },
      perform("x2-del", "contacts.delete-contact", { path: { contactId: "c2" } }),
    );
    mock().llm.on({ toolCallId: "x2-del" }, { content: "Deleted c2." });
    const ghl2 = createFakeGhl({ "*": { body: {} } });
    const { client, controller, signIn } = apiFor(ghl2);
    const mine = client.getAgentController("locus").session(RESOURCE);
    await mine.create();
    const stream = await watch(mine);
    await mine.sendMessage("Delete contact c2");
    await stream.next((e) => e.type === "tool_approval_required");

    // Member m2 naming m1's scope still lands in a session of their own.
    signIn({ memberId: "m2", locationId: "loc-A" });
    const theirs = client.getAgentController("locus").session(RESOURCE, "member:m1");
    await theirs.create();
    const live = (scope?: string) => controller().getSessionByResource(RESOURCE, scope);
    const [m1, m2] = [await live("member:m1"), await live("member:m2")];
    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    expect(m2).not.toBe(m1);
    expect(await live()).toBeUndefined();
    stream.stop();

    // But the change waiting in the client's thread is the client's: anyone who may act on
    // this client may decide it, as with `decideApproval`.
    expect(await theirs.approveTool("x2-del", true)).toEqual({ ok: true });
  });
});
