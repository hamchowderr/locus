import type { GhlSession } from "@locus/ghl";
import { createFakeGhl, type FakeRoutes, type RecordedRequest, useAimock } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { createLocusAgent } from "./agent.ts";
import { createTestWriteGuard, memoryLedger, type WriteGuard } from "./test-mode.ts";

const mock = useAimock();

const session: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-A" };

// Level-1 scenarios, one per CRM area: AIMock plays a model that already knows what to do, the
// fake GHL answers like GHL does, and each test checks the requests that reach GHL and what the
// model is shown. The model's *choices* are scripted, so these prove the plumbing of a realistic
// multi-step task, not the model's judgement (that is level 2).

interface Call {
  id: string;
  name: "load_skill" | "query_data" | "perform_action";
  args: unknown;
}

/**
 * Scripts the model: on `prompt` it makes the first turn's calls, after each turn's last tool
 * result it makes the next turn's, and after the last turn it answers `answer`.
 */
let scripts = 0;
function script(prompt: RegExp, turns: Call[][], answer: string) {
  // Fixtures outlive a test, so call ids are made unique per script or one test's fixture
  // would answer another's tool result.
  const run = ++scripts;
  const idOf = (call: Call) => `s${run}-${call.id}`;
  const toolCalls = (calls: Call[]) =>
    calls.map((c) => ({ id: idOf(c), name: c.name, arguments: JSON.stringify(c.args) }));
  const lastId = (calls: Call[]) => {
    const call = calls.at(-1);
    return call ? idOf(call) : "";
  };

  turns.forEach((calls, i) => {
    const previous = turns[i - 1];
    const match = previous
      ? { toolCallId: lastId(previous) }
      : { userMessage: prompt, hasToolResult: false };
    mock().llm.on(match, { toolCalls: toolCalls(calls) });
  });
  const last = turns.at(-1);
  mock().llm.on(last ? { toolCallId: lastId(last) } : { userMessage: prompt }, { content: answer });
}

function agentOver(routes: FakeRoutes, writeGuard?: WriteGuard) {
  const ghl = createFakeGhl(routes);
  const agent = createLocusAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    session,
    fetch: ghl.fetch,
    ...(writeGuard ? { writeGuard } : {}),
  });
  return { ghl, agent };
}

/** Everything the agent sent back to the model, tool results included, as one string. */
function shownToModel(): string {
  return mock()
    .llm.getRequests()
    .map((entry) => JSON.stringify(entry.body ?? ""))
    .join("\n");
}

const sent = (ghl: { requests: RecordedRequest[] }) =>
  ghl.requests.map((r) => `${r.method} ${r.url.pathname}`);

describe("contacts", () => {
  test("creates a lead, then tags it, adds a note and a follow-up task on the new id", async () => {
    script(
      /add jane doe/i,
      [
        [{ id: "skill", name: "load_skill", args: { category: "contacts" } }],
        [
          {
            id: "create",
            name: "perform_action",
            args: {
              operation: "contacts.create-contact",
              params: {
                body: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
              },
            },
          },
        ],
        [
          {
            id: "tag",
            name: "perform_action",
            args: {
              operation: "contacts.add-tags",
              params: { path: { contactId: "c-new" }, body: { tags: ["hot-lead"] } },
            },
          },
          {
            id: "note",
            name: "perform_action",
            args: {
              operation: "contacts.create-note",
              params: { path: { contactId: "c-new" }, body: { body: "Met at the webinar" } },
            },
          },
          {
            id: "task",
            name: "perform_action",
            args: {
              operation: "contacts.create-task",
              params: {
                path: { contactId: "c-new" },
                body: { title: "Call Jane", dueDate: "2026-10-20T15:00:00Z", completed: false },
              },
            },
          },
        ],
      ],
      "Added Jane Doe, tagged her hot-lead, and left a note and a call task.",
    );
    const { ghl, agent } = agentOver({
      "POST /contacts/": { status: 201, body: { contact: { id: "c-new", firstName: "Jane" } } },
      "POST /contacts/c-new/tags": { status: 201, body: { tags: ["hot-lead"] } },
      "POST /contacts/c-new/notes": { status: 201, body: { note: { id: "n1" } } },
      "POST /contacts/c-new/tasks": { status: 201, body: { task: { id: "t1" } } },
    });

    const result = await agent.generate("Add Jane Doe (jane@example.com) as a hot lead", {
      maxSteps: 6,
    });

    expect(result.text).toMatch(/Added Jane Doe/);
    expect(sent(ghl)).toEqual([
      "POST /contacts/",
      "POST /contacts/c-new/tags",
      "POST /contacts/c-new/notes",
      "POST /contacts/c-new/tasks",
    ]);
    expect(ghl.requests[0]?.body).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      locationId: "loc-A",
    });
    expect(ghl.requests[1]?.body).toEqual({ tags: ["hot-lead"] });
    expect(ghl.requests.every((r) => r.headers.authorization === "Bearer tok")).toBe(true);
    // The new id came back to the model from GHL's response, so it never had to invent one.
    expect(shownToModel()).toContain("c-new");
  });
});

describe("pipelines and opportunities", () => {
  const pipelines = [
    {
      id: "p-sales",
      name: "Sales",
      stages: [
        { id: "s-new", name: "New lead" },
        { id: "s-won", name: "Won" },
      ],
    },
    { id: "p-rec", name: "Recruiting", stages: [{ id: "s-hired", name: "Won" }] },
  ];
  const opportunities = [
    { id: "o1", name: "Ada - website", pipelineId: "p-sales", status: "open" },
    { id: "o2", name: "Grace - ads", pipelineId: "p-sales", status: "open" },
    { id: "o3", name: "Old deal", pipelineId: "p-sales", status: "lost" },
  ];

  test("finds the stage id inside the nested pipeline and moves only open deals to it", async () => {
    script(
      /move .* to won/i,
      [
        [{ id: "skill", name: "load_skill", args: { category: "opportunities" } }],
        [
          {
            id: "read",
            name: "query_data",
            args: {
              sources: [
                { as: "pipelines", operation: "opportunities.get-pipelines" },
                {
                  as: "opps",
                  operation: "opportunities.search-opportunity",
                  params: { query: { pipelineId: "p-sales", status: "open" } },
                },
              ],
              sql: `SELECT o.id AS opportunityId, json_extract(s.value, '$.id') AS stageId
                    FROM opps o
                    JOIN pipelines p ON p.id = o.pipelineId,
                         json_each(p.stages) s
                    WHERE p.name = 'Sales' AND json_extract(s.value, '$.name') = 'Won'
                      AND o.status = 'open'
                    ORDER BY o.id`,
            },
          },
        ],
        [
          {
            id: "move1",
            name: "perform_action",
            args: {
              operation: "opportunities.update-opportunity",
              params: { path: { id: "o1" }, body: { pipelineStageId: "s-won" } },
            },
          },
          {
            id: "move2",
            name: "perform_action",
            args: {
              operation: "opportunities.update-opportunity",
              params: { path: { id: "o2" }, body: { pipelineStageId: "s-won" } },
            },
          },
        ],
      ],
      "Moved 2 open deals to Won.",
    );
    const { ghl, agent } = agentOver({
      "GET /opportunities/pipelines": { body: { pipelines } },
      "GET /opportunities/search": (req) => {
        const status = req.url.searchParams.get("status");
        const rows = opportunities.filter((o) => !status || o.status === status);
        return { body: { opportunities: rows, meta: { total: rows.length } } };
      },
      "*": (req) => ({ body: { opportunity: { id: req.url.pathname.split("/").at(-1) } } }),
    });

    const result = await agent.generate("Move the open Sales deals to Won", { maxSteps: 6 });

    expect(result.text).toBe("Moved 2 open deals to Won.");
    // The SQL answer — two deals, the Sales pipeline's Won stage — is what the model saw.
    const shown = shownToModel();
    expect(shown).toContain('\\"opportunityId\\":\\"o1\\",\\"stageId\\":\\"s-won\\"');
    expect(shown).toContain('\\"opportunityId\\":\\"o2\\",\\"stageId\\":\\"s-won\\"');
    expect(shown).not.toContain("s-hired");

    const reads = ghl.requests.filter((r) => r.method === "GET");
    expect(reads.every((r) => r.url.searchParams.get("locationId") === "loc-A")).toBe(true);
    const search = reads.find((r) => r.url.pathname === "/opportunities/search");
    expect(search?.url.searchParams.get("pipelineId")).toBe("p-sales");
    expect(search?.url.searchParams.get("page")).toBe("1");

    const writes = ghl.requests.filter((r) => r.method === "PUT");
    expect(writes.map((r) => [r.url.pathname, r.body])).toEqual([
      ["/opportunities/o1", { pipelineStageId: "s-won" }],
      ["/opportunities/o2", { pipelineStageId: "s-won" }],
    ]);
  });
});

describe("calendars", () => {
  test("books an appointment on the calendar it looked up, for the contact it found", async () => {
    script(
      /book ada/i,
      [
        [{ id: "skill", name: "load_skill", args: { category: "calendars" } }],
        [
          {
            id: "read",
            name: "query_data",
            args: {
              sources: [
                { as: "calendars", operation: "calendars.get-calendars" },
                {
                  as: "people",
                  operation: "contacts.search-contacts-advanced",
                  params: { body: { query: "ada@example.com" } },
                },
              ],
              sql: `SELECT c.id AS calendarId, p.id AS contactId
                    FROM calendars c, people p
                    WHERE c.name = 'Consultation' AND p.email = 'ada@example.com'`,
            },
          },
        ],
        [
          {
            id: "book",
            name: "perform_action",
            args: {
              operation: "calendars.create-appointment",
              params: {
                body: {
                  calendarId: "cal-consult",
                  contactId: "c-ada",
                  startTime: "2026-10-15T15:00:00-04:00",
                  title: "Consultation with Ada",
                },
              },
            },
          },
        ],
      ],
      "Booked Ada for a consultation tomorrow at 3pm.",
    );
    const { ghl, agent } = agentOver({
      "GET /calendars/": {
        body: {
          calendars: [
            { id: "cal-consult", name: "Consultation" },
            { id: "cal-demo", name: "Demo" },
          ],
        },
      },
      "POST /contacts/search": {
        body: { contacts: [{ id: "c-ada", email: "ada@example.com" }], total: 1 },
      },
      "POST /calendars/events/appointments": {
        status: 201,
        body: { id: "appt-1", calendarId: "cal-consult", contactId: "c-ada" },
      },
    });

    const result = await agent.generate("Book Ada (ada@example.com) a consultation tomorrow 3pm", {
      maxSteps: 6,
    });

    expect(result.text).toMatch(/Booked Ada/);
    expect(shownToModel()).toContain(
      '\\"calendarId\\":\\"cal-consult\\",\\"contactId\\":\\"c-ada\\"',
    );
    expect(sent(ghl)).toEqual([
      "GET /calendars/",
      "POST /contacts/search",
      "POST /calendars/events/appointments",
    ]);
    // Searches are reads even though they are POSTs; paging and the client go in the body.
    expect(ghl.requests[1]?.body).toMatchObject({ query: "ada@example.com", locationId: "loc-A" });
    expect(ghl.requests[2]?.body).toEqual({
      calendarId: "cal-consult",
      contactId: "c-ada",
      startTime: "2026-10-15T15:00:00-04:00",
      title: "Consultation with Ada",
      locationId: "loc-A",
    });
  });
});

describe("conversations", () => {
  test("texts the contact it found, and reads the thread first without writing", async () => {
    script(
      /text ada/i,
      [
        [{ id: "skill", name: "load_skill", args: { category: "conversations" } }],
        [
          {
            id: "read",
            name: "query_data",
            args: {
              sources: [
                {
                  as: "threads",
                  operation: "conversations.search-conversation",
                  params: { query: { query: "Ada" } },
                },
              ],
              sql: "SELECT contactId, lastMessageBody FROM threads ORDER BY dateUpdated DESC LIMIT 1",
            },
          },
        ],
        [
          {
            id: "send",
            name: "perform_action",
            args: {
              operation: "conversations.send-a-new-message",
              params: {
                body: { type: "SMS", contactId: "c-ada", message: "See you tomorrow at 3!" },
              },
            },
          },
        ],
      ],
      "Texted Ada.",
    );
    const { ghl, agent } = agentOver({
      "GET /conversations/search": {
        body: {
          conversations: [
            {
              id: "conv-1",
              contactId: "c-ada",
              lastMessageBody: "Is 3pm ok?",
              dateUpdated: 1760400000000,
            },
          ],
          total: 1,
        },
      },
      "POST /conversations/messages": {
        status: 201,
        body: { conversationId: "conv-1", messageId: "m-9" },
      },
    });

    const result = await agent.generate("Text Ada that we'll see her tomorrow at 3", {
      maxSteps: 6,
    });

    expect(result.text).toBe("Texted Ada.");
    expect(shownToModel()).toContain("Is 3pm ok?");
    expect(sent(ghl)).toEqual(["GET /conversations/search", "POST /conversations/messages"]);
    expect(ghl.requests[0]?.url.searchParams.get("locationId")).toBe("loc-A");
    expect(ghl.requests[1]?.body).toEqual({
      type: "SMS",
      contactId: "c-ada",
      message: "See you tomorrow at 3!",
    });
  });
});

describe("workflows", () => {
  test("enrolls every contact with a tag into the workflow it looked up by name", async () => {
    const tagged = [
      { id: "c1", tags: ["webinar"] },
      { id: "c2", tags: ["webinar", "vip"] },
    ];
    script(
      /enroll .* nurture/i,
      [
        [
          { id: "skill-w", name: "load_skill", args: { category: "workflows" } },
          { id: "skill-c", name: "load_skill", args: { category: "contacts" } },
        ],
        [
          {
            id: "read",
            name: "query_data",
            args: {
              sources: [
                { as: "workflows", operation: "workflows.get-workflow" },
                {
                  as: "people",
                  operation: "contacts.search-contacts-advanced",
                  params: {
                    body: { filters: [{ field: "tags", operator: "contains", value: "webinar" }] },
                  },
                },
              ],
              sql: `SELECT p.id AS contactId, w.id AS workflowId
                    FROM people p, workflows w WHERE w.name = 'Nurture' ORDER BY p.id`,
            },
          },
        ],
        tagged.map((c) => ({
          id: `enroll-${c.id}`,
          name: "perform_action" as const,
          args: {
            operation: "contacts.add-contact-to-workflow",
            params: { path: { contactId: c.id, workflowId: "wf-nurture" } },
          },
        })),
      ],
      "Enrolled 2 contacts in Nurture.",
    );
    const { ghl, agent } = agentOver({
      "GET /workflows/": {
        body: {
          workflows: [
            { id: "wf-nurture", name: "Nurture", status: "published" },
            { id: "wf-other", name: "Onboarding", status: "draft" },
          ],
        },
      },
      "POST /contacts/search": { body: { contacts: tagged, total: tagged.length } },
      "*": { status: 201, body: { succeded: true } },
    });

    const result = await agent.generate("Enroll everyone tagged webinar into Nurture", {
      maxSteps: 6,
    });

    expect(result.text).toBe("Enrolled 2 contacts in Nurture.");
    expect(shownToModel()).toContain('\\"contactId\\":\\"c2\\",\\"workflowId\\":\\"wf-nurture\\"');
    expect(sent(ghl).filter((r) => r.includes("/workflow/"))).toEqual([
      "POST /contacts/c1/workflow/wf-nurture",
      "POST /contacts/c2/workflow/wf-nurture",
    ]);
  });
});

describe("guard rails through the agent", () => {
  test("a deletion stops for a person's approval and nothing reaches GHL", async () => {
    script(
      /delete/i,
      [
        [
          {
            id: "del",
            name: "perform_action",
            args: { operation: "contacts.delete-contact", params: { path: { contactId: "c1" } } },
          },
        ],
      ],
      "Deleted.",
    );
    const { ghl, agent } = agentOver({ "*": { body: { succeded: true } } });

    const result = await agent.generate("Delete contact c1", { maxSteps: 3 });

    expect(result.finishReason).toBe("suspended");
    expect(result.suspendPayload).toMatchObject({ toolName: "perform_action" });
    expect(ghl.requests).toEqual([]);
  });

  test("a client named by the model is refused, the model is told why, and its retry goes through", async () => {
    const bad = {
      operation: "contacts.create-contact",
      params: { body: { firstName: "Ada", locationId: "loc-OTHER" } },
    };
    mock().llm.on(
      { userMessage: /add ada/i, hasToolResult: false },
      { toolCalls: [{ id: "g1-try1", name: "perform_action", arguments: JSON.stringify(bad) }] },
    );
    mock().llm.on(
      { toolCallId: "g1-try1", toolResultContains: "locationId comes from the session" },
      {
        toolCalls: [
          {
            id: "g1-try2",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.create-contact",
              params: { body: { firstName: "Ada" } },
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "g1-try2" }, { content: "Added Ada." });
    const { ghl, agent } = agentOver({
      "POST /contacts/": { status: 201, body: { contact: { id: "c-ada" } } },
    });

    const result = await agent.generate("Add Ada to the other client", { maxSteps: 4 });

    expect(result.text).toBe("Added Ada.");
    expect(ghl.requests).toHaveLength(1);
    expect(ghl.requests[0]?.body).toEqual({ firstName: "Ada", locationId: "loc-A" });
  });

  test("a GHL validation error comes back to the model as data it can fix", async () => {
    mock().llm.on(
      { userMessage: /add a contact/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "g2-try1",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.create-contact",
              params: { body: { email: "not-an-email" } },
            }),
          },
        ],
      },
    );
    mock().llm.on(
      { toolCallId: "g2-try1", toolResultContains: "email must be an email" },
      { content: "GHL rejected the email address; please check it." },
    );
    const { ghl, agent } = agentOver({
      "POST /contacts/": {
        status: 422,
        body: { statusCode: 422, message: ["email must be an email"] },
      },
    });

    const result = await agent.generate("Add a contact with email not-an-email", { maxSteps: 3 });

    expect(result.text).toMatch(/rejected the email/);
    expect(ghl.requests).toHaveLength(1);
  });

  test("in test-write mode a contact that could be a real person is refused before sending", async () => {
    mock().llm.on(
      { userMessage: /real person/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "g3-try1",
            name: "perform_action",
            arguments: JSON.stringify({
              operation: "contacts.create-contact",
              params: { body: { firstName: "Ada", email: "ada@gmail.com", phone: "+15551234" } },
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "g3-try1" }, { content: "Refused." });
    const writeGuard = createTestWriteGuard({ run: "run-1", ledger: memoryLedger() });
    const { ghl, agent } = agentOver({ "*": { status: 201, body: {} } }, writeGuard);

    const result = await agent.generate("Add a real person", { maxSteps: 3 });

    expect(result.text).toBe("Refused.");
    expect(ghl.requests).toEqual([]);
    expect(shownToModel()).toMatch(/Locus Test/);
  });
});
