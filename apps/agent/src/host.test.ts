import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatKitKey, type SessionContext } from "@locus/auth";
import { connectAgency, createStubGhl, STUB_CODE } from "@locus/connect";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import {
  session as authSession,
  location,
  member,
  memberLocation,
  organization,
  user,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, useAimock } from "@locus/testing";
import { MastraClient } from "@mastra/client-js";
import type { MastraModelConfig } from "@mastra/core/llm";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHost, PREFIX, sessionFromKitToken } from "./host.ts";
import { SCRIPTED_REPLY, scriptedModel } from "./scripted-model.ts";

const mock = useAimock();
const now = new Date();
let dir: string;
let db: ControlDb;

beforeEach(async () => {
  mock().llm.clearRequests();
  dir = await mkdtemp(join(tmpdir(), "locus-agent-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** A signed-in Better Auth session row, as the web app's sign-in leaves. */
async function signIn(id: string, userId: string) {
  await db.insert(authSession).values({
    id,
    token: `token-${id}`,
    userId,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: now,
    updatedAt: now,
  });
}

/** An agency connected to the stub GHL, an owner and a restricted member, and their sessions. */
async function agency() {
  await db.insert(organization).values({ id: "org", name: "Org", slug: "org", createdAt: now });
  for (const [id, role] of [
    ["owner", "owner"],
    ["staff", "member"],
  ] as const) {
    await db.insert(user).values({ id, name: id, email: `${id}@agency.test`, emailVerified: true });
    await db
      .insert(member)
      .values({ id: `m-${id}`, userId: id, organizationId: "org", role, createdAt: now });
  }
  const connect = {
    db,
    secrets: new MemorySecretStore(),
    provisioner: new LocalProvisioner(join(dir, "tenants")),
    ghl: {
      clientId: "stub-client",
      clientSecret: "stub-secret",
      appId: "stub-app",
      redirectUri: "http://locus.test/api/connect/crm/callback",
      scopes: [],
    },
    http: { fetch: createStubGhl(), baseUrl: "https://stub.ghl.local" },
  };
  await signIn("s", "owner");
  await signIn("s2", "staff");
  const ownerCtx: SessionContext = { id: "s", userId: "owner", activeOrganizationId: "org" };
  await connectAgency(connect, ownerCtx, STUB_CODE);
  const [first] = await db.select().from(location).limit(1);
  if (!first) throw new Error("no client registered");
  const sessions: Record<string, SessionContext> = {
    owner: { ...ownerCtx, activeLocationId: first.id },
    staff: { id: "s2", userId: "staff", activeOrganizationId: "org", activeLocationId: first.id },
  };
  return { connect, client: first, sessions };
}

/** A second agency holding a row for the same GHL location, with its own database. */
async function secondAgencyFor(
  connect: { provisioner: LocalProvisioner },
  ghlLocationId: string,
): Promise<SessionContext> {
  await db.insert(organization).values({ id: "org2", name: "Org2", slug: "org2", createdAt: now });
  await db
    .insert(user)
    .values({ id: "owner2", name: "o2", email: "o2@b.test", emailVerified: true });
  await db.insert(member).values({
    id: "m-owner2",
    userId: "owner2",
    organizationId: "org2",
    role: "owner",
    createdAt: now,
  });
  await signIn("s3", "owner2");
  const { dbName, hostname } = await connect.provisioner.create("other");
  await db.insert(location).values({
    id: "client-b",
    organizationId: "org2",
    ghlLocationId,
    name: "Same sub-account",
    tursoDbName: dbName,
    tursoDbHostname: hostname,
    status: "active",
  });
  return { id: "s3", userId: "owner2", activeOrganizationId: "org2", activeLocationId: "client-b" };
}

async function hostFor(signedIn: { as: string | null }, model?: MastraModelConfig) {
  const { connect, client, sessions } = await agency();
  sessions.owner2 = await secondAgencyFor(connect, client.ghlLocationId);
  const ghl = createFakeGhl({ "*": { body: {} } });
  const host = createHost({
    db,
    session: async () => (signedIn.as ? (sessions[signedIn.as] ?? null) : null),
    connect,
    model: model ?? { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    fetch: ghl.fetch,
    origin: "http://locus.test",
  });
  const chat = new MastraClient({
    baseUrl: "http://agent.test",
    apiPrefix: PREFIX,
    retries: 0,
    fetch: (input, init) => host.fetch(new Request(input, init)),
  });
  return { host, chat, ghl, client };
}

describe("the agent server", () => {
  test("answers its health check", async () => {
    const { host } = await hostFor({ as: null });
    expect((await host.fetch(new Request("http://agent.test/health"))).status).toBe(200);
  });

  test("a deletion in the signed-in member's client waits, then goes through with that client's token", async () => {
    mock().llm.on(
      { userMessage: /delete contact c1/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "h1-del",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.delete-contact",
              params: { path: { contactId: "c1" } },
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "h1-del" }, { content: "Deleted c1." });
    const { chat, ghl, client } = await hostFor({ as: "owner" });
    const session = chat.getAgentController("locus").session(`client:${client.ghlLocationId}`);
    await session.create();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the run never ended")), 10_000);
      void session.subscribe({
        onEvent: (event) => {
          const e = event as { type: string; toolCallId?: string };
          if (e.type === "tool_approval_required") void session.approveTool("h1-del", true);
          if (e.type === "agent_end") {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });
    await session.sendMessage("Delete contact c1");
    await done;

    expect(ghl.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "DELETE /contacts/c1",
    ]);
    expect(ghl.requests[0]?.headers.authorization).toMatch(
      new RegExp(`^Bearer stub-location-token-${client.ghlLocationId}-`),
    );
  });

  test("a member without access to their active client is not let in", async () => {
    const { host, client } = await hostFor({ as: "staff" });
    const res = await host.fetch(
      new Request(
        `http://agent.test${PREFIX}/agent-controller/locus/sessions/${encodeURIComponent(
          `client:${client.ghlLocationId}`,
        )}`,
      ),
    );
    expect(res.status).toBe(401);
  });

  test("nobody signed in is not let in", async () => {
    const { host } = await hostFor({ as: null });
    const res = await host.fetch(
      new Request(`http://agent.test${PREFIX}/agent-controller/locus/modes`),
    );
    expect(res.status).toBe(401);
  });

  test("the scripted model answers without any AI provider", async () => {
    const { chat, client } = await hostFor({ as: "owner" }, await scriptedModel());
    const session = chat.getAgentController("locus").session(`client:${client.ghlLocationId}`);
    await session.create();
    await session.createThread("Hello");
    const events: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      void session.subscribe({
        onEvent: (e) => {
          events.push(e);
          if ((e as { type: string }).type === "agent_end") resolve();
        },
      });
    });
    await session.sendMessage("Hello there");
    await done;
    expect(JSON.stringify(events)).toContain(SCRIPTED_REPLY);
  });

  test("two agencies holding the same GHL location never share a conversation", async () => {
    const signedIn = { as: "owner" as string | null };
    const { chat, client } = await hostFor(signedIn);
    const resource = `client:${client.ghlLocationId}`;
    const mine = chat.getAgentController("locus").session(resource);
    await mine.create();
    const thread = await mine.createThread("Agency A's plans");

    signedIn.as = "owner2";
    const theirs = chat.getAgentController("locus").session(resource);
    await theirs.create();
    const listed = JSON.stringify(await theirs.listThreads());
    expect(listed).not.toContain(thread.id);
    expect(listed).not.toContain("Agency A's plans");
  });

  test("a change waiting in a client that is then suspended can't be approved", async () => {
    mock().llm.on(
      { userMessage: /delete contact c9/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "h9-del",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.delete-contact",
              params: { path: { contactId: "c9" } },
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "h9-del" }, { content: "Done." });
    const { chat, ghl, client } = await hostFor({ as: "owner" });
    const session = chat.getAgentController("locus").session(`client:${client.ghlLocationId}`);
    await session.create();
    const waiting = new Promise<void>((resolve) => {
      void session.subscribe({
        onEvent: (event) => {
          if ((event as { type: string }).type === "tool_approval_required") resolve();
        },
      });
    });
    await session.sendMessage("Delete contact c9");
    await waiting;
    await db.update(location).set({ status: "suspended" }).where(eq(location.id, client.id));

    await expect(session.approveTool("h9-del", true)).rejects.toThrow(/401/);
    expect(ghl.requests).toEqual([]);
  });

  test("posts must be JSON from the web app's own pages, and small", async () => {
    const { host, client } = await hostFor({ as: "owner" });
    const url = `http://agent.test${PREFIX}/agent-controller/locus/sessions`;
    const body = JSON.stringify({ resourceId: `client:${client.ghlLocationId}` });
    const post = (headers: Record<string, string>, data: string = body) =>
      host.fetch(new Request(url, { method: "POST", headers, body: data }));
    expect(
      (await post({ "content-type": "application/json", origin: "https://evil.test" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "text/plain", origin: "http://locus.test" })).status).toBe(
      415,
    );
    const huge = JSON.stringify({ resourceId: "x".repeat(1_100_000) });
    expect((await post({ "content-type": "application/json" }, huge)).status).toBe(413);
    expect(
      (await post({ "content-type": "application/json", origin: "http://locus.test" })).status,
    ).toBe(200);
  });

  test("Stop works: an abort with an empty body and no content type goes through", async () => {
    const { chat, host, client } = await hostFor({ as: "owner" });
    const resource = `client:${client.ghlLocationId}`;
    await chat.getAgentController("locus").session(resource).create();
    // As the Node server hands it over: every POST has a body stream, even an empty one.
    const empty = new ReadableStream({ start: (c) => c.close() });
    const res = await host.fetch(
      new Request(
        `http://agent.test${PREFIX}/agent-controller/locus/sessions/${encodeURIComponent(resource)}/abort`,
        {
          method: "POST",
          headers: { origin: "http://locus.test" },
          body: empty,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(res.status).toBe(200);
  });

  test("a member removed mid-run gets no more GHL calls, even after someone else uses the client", async () => {
    const signedIn = { as: "staff" as string | null };
    const update = (id: string, contactId: string) => ({
      toolCalls: [
        {
          id,
          name: "perform_action",
          arguments: JSON.stringify({
            operation: "contacts.update-contact",
            params: { path: { contactId }, body: { firstName: "A" } },
          }),
        },
      ],
    });
    mock().llm.on(
      { userMessage: /update two contacts/i, hasToolResult: false },
      update("r1", "c1"),
    );
    mock().llm.on({ toolCallId: "r1" }, update("r2", "c2"));
    mock().llm.on({ toolCallId: "r2" }, { content: "Done." });

    let revoked: Promise<unknown> | undefined;
    const ghl = createFakeGhl({
      "*": (req) => {
        // While the first change is with GHL, an admin takes the client away from staff, and
        // then the owner uses the client.
        if (req.url.pathname === "/contacts/c1") {
          revoked = (async () => {
            await db.delete(memberLocation).where(eq(memberLocation.memberId, "m-staff"));
            signedIn.as = "owner";
            await chat.getAgentController("locus").session(resource).create();
          })();
        }
        return { body: {} };
      },
    });
    const { connect, client, sessions } = await agency();
    await db.insert(memberLocation).values({ memberId: "m-staff", locationId: client.id });
    const resource = `client:${client.ghlLocationId}`;
    const host = createHost({
      db,
      session: async () => (signedIn.as ? (sessions[signedIn.as] ?? null) : null),
      connect,
      model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
      fetch: ghl.fetch,
      origin: "http://locus.test",
    });
    const chat = new MastraClient({
      baseUrl: "http://agent.test",
      apiPrefix: PREFIX,
      retries: 0,
      fetch: (input, init) => host.fetch(new Request(input, init)),
    });
    const session = chat.getAgentController("locus").session(resource);
    await session.create();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the run never ended")), 10_000);
      void session.subscribe({
        onEvent: (event) => {
          if ((event as { type: string }).type === "agent_end") {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });
    await session.sendMessage("Update two contacts");
    await done;
    await revoked;

    expect(ghl.requests.map((r) => r.url.pathname)).toEqual(["/contacts/c1"]);
  });

  test("a member removed from a client stops receiving its live chat", async () => {
    mock().llm.on({ userMessage: /status report/i }, { content: "Everything is on track." });
    const signedIn = { as: "staff" as string | null };
    const { connect, client, sessions } = await agency();
    await db.insert(memberLocation).values({ memberId: "m-staff", locationId: client.id });
    const host = createHost({
      db,
      session: async () => (signedIn.as ? (sessions[signedIn.as] ?? null) : null),
      connect,
      model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
      origin: "http://locus.test",
      streamCheckMs: 50,
    });
    const chat = new MastraClient({
      baseUrl: "http://agent.test",
      apiPrefix: PREFIX,
      retries: 0,
      fetch: (input, init) => host.fetch(new Request(input, init)),
    });
    const resource = `client:${client.ghlLocationId}`;
    const staff = chat.getAgentController("locus").session(resource);
    await staff.create();
    const thread = await staff.createThread("Shared");
    const seen: string[] = [];
    const ended: unknown[] = [];
    await staff.subscribe({
      onEvent: (e) => void seen.push((e as { type: string }).type),
      // The stream is cut, and reconnecting is refused.
      onError: (error) => void ended.push(error),
    });

    await db.delete(memberLocation).where(eq(memberLocation.memberId, "m-staff"));
    await new Promise((r) => setTimeout(r, 200));
    const before = seen.length;

    signedIn.as = "owner";
    const owner = chat.getAgentController("locus").session(resource);
    await owner.create({ threadId: thread.id });
    const ownerDone = new Promise<void>((resolve) => {
      void owner.subscribe({
        onEvent: (e) => {
          if ((e as { type: string }).type === "agent_end") resolve();
        },
      });
    });
    await owner.sendMessage("Status report");
    await ownerDone;
    await new Promise((r) => setTimeout(r, 100));

    expect(seen.slice(before)).toEqual([]);
    expect(ended).not.toEqual([]);
  });

  test("an event stream asked for by an encoded path is cut for a removed member too", async () => {
    const { connect, client, sessions } = await agency();
    await db.insert(memberLocation).values({ memberId: "m-staff", locationId: client.id });
    const host = createHost({
      db,
      session: async () => sessions.staff ?? null,
      connect,
      model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
      origin: "http://locus.test",
      streamCheckMs: 50,
    });
    const chat = new MastraClient({
      baseUrl: "http://agent.test",
      apiPrefix: PREFIX,
      retries: 0,
      fetch: (input, init) => host.fetch(new Request(input, init)),
    });
    const resource = `client:${client.ghlLocationId}`;
    await chat.getAgentController("locus").session(resource).create();

    const response = await host.fetch(
      new Request(
        `http://agent.test${PREFIX}/agent-controller/locus/sessions/${encodeURIComponent(resource)}/%73tream`,
      ),
    );
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = response.body?.getReader();
    await db.delete(memberLocation).where(eq(memberLocation.memberId, "m-staff"));
    const ended = await Promise.race([
      (async () => {
        while (!(await reader?.read())?.done) {}
        return true;
      })(),
      new Promise((r) => setTimeout(() => r(false), 2_000)),
    ]);
    expect(ended).toBe(true);
  });
  test("a request that fails is logged with its cause, and the caller sees no detail", async () => {
    const { connect, sessions } = await agency();
    const logged: unknown[][] = [];
    const host = createHost({
      db,
      session: async () => sessions.owner ?? null,
      connect: {
        ...connect,
        provisioner: Object.assign(Object.create(connect.provisioner), {
          mintToken: async () => {
            throw new Error("database token refused");
          },
        }),
      },
      model: await scriptedModel(),
      origin: "http://locus.test",
      logError: (...args) => logged.push(args),
    });
    const res = await host.fetch(
      new Request(`http://agent.test${PREFIX}/kit/agent-controller/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello there" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toContain("database token refused");
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain(`POST ${PREFIX}/kit/agent-controller/stream`);
    expect(JSON.stringify(logged[0]) + String(logged[0]?.[1])).toContain("database token refused");
  });
});

/** A token as the chat kit's proxy signs it. */
function kitToken(key: string, sub: string, exp = Math.floor(Date.now() / 1000) + 300) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, exp })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

describe("the chat kit", () => {
  test("a token from the web app names a signed-in session; a bad or stale one, nobody", async () => {
    await agency();
    const key = chatKitKey("secret");
    const lookup = sessionFromKitToken(db, key);
    const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });
    expect(await lookup(bearer(kitToken(key, "s")))).toMatchObject({ id: "s", userId: "owner" });
    expect(await lookup(bearer(kitToken(chatKitKey("other"), "s")))).toBeNull();
    expect(await lookup(bearer(kitToken(key, "nobody")))).toBeNull();
    await db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(authSession.id, "s"));
    expect(await lookup(bearer(kitToken(key, "s")))).toBeNull();
    expect(await lookup(new Headers())).toBeUndefined();
  });

  test("a message streams its reply on the kit's own route", async () => {
    const { host } = await hostFor({ as: "owner" }, await scriptedModel());
    const res = await host.fetch(
      new Request(`http://agent.test${PREFIX}/kit/agent-controller/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello there" }),
      }),
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const text = await res.text();
    expect(text).toContain(SCRIPTED_REPLY);
    expect(text).toContain('"type":"__done__"');
  });

  test("a message may carry attachments larger than other posts", async () => {
    const { host } = await hostFor({ as: "owner" }, await scriptedModel());
    const post = (path: string) =>
      host.fetch(
        new Request(`http://agent.test${PREFIX}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Hello there", padding: "x".repeat(1_500_000) }),
        }),
      );
    const kit = await post("kit/agent-controller/stream");
    expect(kit.status).not.toBe(413);
    await kit.text();
    expect((await post("kit/agent-controller/answer")).status).toBe(413);
  });

  test("a member removed while a change waits loses the run, not just the stream", async () => {
    mock().llm.on(
      { userMessage: /delete contact c3/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "kh-del",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.delete-contact",
              params: { path: { contactId: "c3" } },
            }),
          },
        ],
      },
    );
    const { connect, sessions, client } = await agency();
    await db.insert(memberLocation).values({ memberId: "m-staff", locationId: client.id });
    const host = createHost({
      db,
      session: async () => sessions.staff ?? null,
      connect,
      model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
      fetch: createFakeGhl({ "*": { body: {} } }).fetch,
      origin: "http://locus.test",
      streamCheckMs: 50,
    });
    const kit = (path: string, body: unknown) =>
      host.fetch(
        new Request(`http://agent.test${PREFIX}/kit/agent-controller/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const res = await kit("stream", { text: "Delete contact c3" });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("tool_approval_required")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended early: ${text}`);
      text += new TextDecoder().decode(value);
    }

    await db.delete(memberLocation).where(eq(memberLocation.memberId, "m-staff"));
    while (!(await reader.read()).done) {}
    // Let them back in: the change they were asked about is gone with the run.
    await db.insert(memberLocation).values({ memberId: "m-staff", locationId: client.id });
    const approve = await kit("approve", { decision: "approve", toolCallId: "kh-del" });
    expect(approve.status).toBe(409);
  });

  test("a member who may not act on their client is refused there too", async () => {
    const { host } = await hostFor({ as: "staff" });
    const res = await host.fetch(
      new Request(`http://agent.test${PREFIX}/kit/agent-controller/threads`),
    );
    expect(res.status).toBe(401);
  });
});
