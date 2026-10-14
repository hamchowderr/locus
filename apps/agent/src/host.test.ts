import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionContext } from "@locus/auth";
import { connectAgency, createStubGhl, STUB_CODE } from "@locus/connect";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import { location, member, organization, user } from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, useAimock } from "@locus/testing";
import { MastraClient } from "@mastra/client-js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHost, PREFIX } from "./host.ts";

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

async function hostFor(signedIn: { as: string | null }) {
  const { connect, client, sessions } = await agency();
  sessions.owner2 = await secondAgencyFor(connect, client.ghlLocationId);
  const ghl = createFakeGhl({ "*": { body: {} } });
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
});
