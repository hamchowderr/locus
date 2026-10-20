/**
 * The sample chats that `scripts/record-chats.ts` records and `recorded-replay.test.ts`
 * replays: the agent host in-process, signed in as an agency's owner, with GoHighLevel replaced
 * by a fake sub-account holding made-up data. Nothing here reaches a real sub-account.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionContext } from "@locus/auth";
import { connectAgency, createStubGhl, STUB_CODE } from "@locus/connect";
import { LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import { session as authSession, location, member, organization, user } from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import {
  createFakeGhl,
  type FakeGhl,
  type FakeResponse,
  type RecordedRequest,
} from "@locus/testing";
import { MastraClient } from "@mastra/client-js";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createHost, PREFIX } from "./host.ts";

export interface SampleChat {
  id: string;
  /** The member's messages, sent in order, each after the last run ended. */
  messages: string[];
  /** How every approval the agent asks for is answered; yes by default. */
  approve?: boolean;
  /** Answers to the agent's questions, in order; past the end, its first option. */
  answers?: string[];
}

export const CHATS_FILE = new URL("../fixtures/chats.json", import.meta.url);

export function loadSampleChats(): SampleChat[] {
  return (JSON.parse(readFileSync(CHATS_FILE, "utf8")) as { chats: SampleChat[] }).chats;
}

// ---- The fake sub-account: made-up people at example domains, nothing real. ----

const contacts = [
  contact("fake-contact-01", "Avery", "Example", "avery@example.com", ["vip", "newsletter"]),
  contact("fake-contact-02", "Jordan", "Sample", "jordan@example.org", ["newsletter"]),
  contact("fake-contact-03", "Casey", "Placeholder", "casey@example.net", ["old-promo"]),
  contact("fake-contact-04", "Riley", "Demo", "riley@example.org", ["vip"]),
  contact("fake-contact-05", "Morgan", "Testcase", "morgan@example.com", []),
  contact("fake-contact-06", "Quinn", "Mockridge", "quinn@example.com", ["vip", "follow-up"]),
];

const tags = ["vip", "newsletter", "old-promo", "follow-up"].map((name, i) => ({
  id: `fake-tag-0${i + 1}`,
  name,
}));

const pipelines = [
  {
    id: "fake-pipeline-sales",
    name: "Sales",
    stages: [
      { id: "fake-stage-new", name: "New lead" },
      { id: "fake-stage-quoted", name: "Quoted" },
      { id: "fake-stage-won", name: "Won" },
    ],
  },
];

const opportunities = [
  opportunity("fake-opp-01", "Website refresh", "fake-stage-new", 1200, "fake-contact-01"),
  opportunity("fake-opp-02", "Monthly SEO", "fake-stage-quoted", 800, "fake-contact-02"),
  opportunity("fake-opp-03", "Logo design", "fake-stage-new", 450, "fake-contact-04"),
  opportunity("fake-opp-04", "Ads setup", "fake-stage-new", 2000, "fake-contact-06"),
  opportunity("fake-opp-05", "Landing page", "fake-stage-won", 950, "fake-contact-05", "won"),
];

function contact(id: string, firstName: string, lastName: string, email: string, t: string[]) {
  const name = `${firstName} ${lastName}`;
  return { id, firstName, lastName, contactName: name, email, tags: t, type: "lead" };
}

function opportunity(
  id: string,
  name: string,
  pipelineStageId: string,
  monetaryValue: number,
  contactId: string,
  status = "open",
) {
  return {
    id,
    name,
    status,
    monetaryValue,
    pipelineId: "fake-pipeline-sales",
    pipelineStageId,
    contactId,
  };
}

const NOT_FOUND: FakeResponse = { status: 404, body: { message: "Not found" } };

function one(list: { id: string }[], id: string | undefined, key: string): FakeResponse {
  const found = list.find((item) => item.id === id);
  return found ? { body: { [key]: found } } : NOT_FOUND;
}

function deleted(list: { id: string }[], id: string | undefined): FakeResponse {
  return list.some((item) => item.id === id) ? { body: { succeded: true } } : NOT_FOUND;
}

function contactTags(req: RecordedRequest, add: boolean, id: string | undefined): FakeResponse {
  const found = contacts.find((c) => c.id === id);
  if (!found) return NOT_FOUND;
  const sent = (req.body as { tags?: string[] } | undefined)?.tags ?? [];
  const next = add
    ? [...new Set([...found.tags, ...sent])]
    : found.tags.filter((t) => !sent.includes(t));
  return { body: { tags: next } };
}

const allContacts = {
  body: { contacts, total: contacts.length, meta: { total: contacts.length } },
};
const allOpportunities = { body: { opportunities, meta: { total: opportunities.length } } };

/** `"METHOD /path"` patterns, the location's id left open, and how each is answered. */
const routes: [RegExp, (req: RecordedRequest, id?: string) => FakeResponse][] = [
  [/^POST \/contacts\/search$/, () => allContacts],
  [/^GET \/contacts$/, () => allContacts],
  [/^GET \/contacts\/([^/]+)$/, (_req, id) => one(contacts, id, "contact")],
  [/^POST \/contacts\/([^/]+)\/tags$/, (req, id) => contactTags(req, true, id)],
  [/^DELETE \/contacts\/([^/]+)\/tags$/, (req, id) => contactTags(req, false, id)],
  [/^DELETE \/contacts\/([^/]+)$/, (_req, id) => deleted(contacts, id)],
  [/^GET \/locations\/[^/]+\/tags$/, () => ({ body: { tags } })],
  [/^GET \/locations\/[^/]+\/tags\/([^/]+)$/, (_req, id) => one(tags, id, "tag")],
  [/^DELETE \/locations\/[^/]+\/tags\/([^/]+)$/, (_req, id) => deleted(tags, id)],
  [/^GET \/opportunities\/pipelines$/, () => ({ body: { pipelines } })],
  [/^(?:GET|POST) \/opportunities\/search$/, () => allOpportunities],
];

/** Answers the GHL calls the agent makes about the fake sub-account; anything else gets `{}`. */
function answer(req: RecordedRequest): FakeResponse {
  const route = `${req.method} ${req.url.pathname.replace(/\/$/, "")}`;
  for (const [pattern, respond] of routes) {
    const match = route.match(pattern);
    if (match) return respond(req, match[1]);
  }
  return { body: {} };
}

export function createSampleGhl(): FakeGhl {
  return createFakeGhl({ "*": answer });
}

// ---- The host, signed in as an agency's owner on its one client. ----

export interface SampleHost {
  chat: MastraClient;
  /** The agent-controller resource of the client the owner is signed in to. */
  resource: string;
  ghl: FakeGhl;
  close: () => Promise<void>;
}

export async function startSampleHost(model: MastraModelConfig): Promise<SampleHost> {
  const now = new Date();
  const dir = await mkdtemp(join(tmpdir(), "locus-sample-chats-"));
  const db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  await db.insert(organization).values({ id: "org", name: "Org", slug: "org", createdAt: now });
  await db
    .insert(user)
    .values({ id: "owner", name: "Owner", email: "owner@agency.test", emailVerified: true });
  await db.insert(member).values({
    id: "m-owner",
    userId: "owner",
    organizationId: "org",
    role: "owner",
    createdAt: now,
  });
  await db.insert(authSession).values({
    id: "s",
    token: "token-s",
    userId: "owner",
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: now,
    updatedAt: now,
  });
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
  const [client] = await db.select().from(location).limit(1);
  if (!client) throw new Error("no client registered");
  const signedIn: SessionContext = { ...ownerCtx, activeLocationId: client.id };
  const ghl = createSampleGhl();
  const host = createHost({
    db,
    session: async () => signedIn,
    connect,
    model,
    fetch: ghl.fetch,
    origin: "http://locus.test",
  });
  const chat = new MastraClient({
    baseUrl: "http://agent.test",
    apiPrefix: PREFIX,
    retries: 0,
    fetch: (input, init) => host.fetch(new Request(input, init)),
  });
  return {
    chat,
    resource: `client:${client.ghlLocationId}`,
    ghl,
    close: async () => {
      db.$client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---- Driving one chat. ----

interface ChatEvent {
  type: string;
  toolCallId?: string;
  [key: string]: unknown;
}

/** Runs `sample` in a new thread, answering approvals and questions; returns every event. */
export async function runSampleChat(
  host: SampleHost,
  sample: SampleChat,
  timeoutMs = 120_000,
): Promise<ChatEvent[]> {
  const session = host.chat.getAgentController("locus").session(host.resource);
  await session.create();
  await session.createThread(sample.id);
  const answers = [...(sample.answers ?? [])];
  const events: ChatEvent[] = [];
  let ends = 0;
  let wanted = 1;
  let ended: () => void = () => {};
  void session.subscribe({
    onEvent: (event) => {
      const e = event as ChatEvent;
      events.push(e);
      if (e.type === "tool_approval_required" && e.toolCallId) {
        void session.approveTool(e.toolCallId, sample.approve ?? true);
      }
      if (e.type === "tool_suspended" && e.toolCallId) {
        // An answer resumes in a second run, which must end too.
        wanted++;
        void session.respondToToolSuspension(e.toolCallId, answers.shift() ?? firstOption(e));
      }
      if (e.type === "agent_end" && ++ends >= wanted) ended();
    },
  });
  for (const message of sample.messages) {
    ends = 0;
    wanted = 1;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${sample.id}: no reply to "${message}" in ${timeoutMs} ms`)),
        timeoutMs,
      );
      ended = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    await session.sendMessage(message);
    await done;
  }
  return events;
}

function firstOption(event: ChatEvent): string {
  const text = JSON.stringify(event);
  return text.match(/"label":"([^"]+)"/)?.[1] ?? "Yes";
}
