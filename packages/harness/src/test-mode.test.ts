import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGhl, type RecordedRequest } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { performAction } from "./actions.ts";
import { cleanupRun, createTestWriteGuard, fileLedger, memoryLedger } from "./test-mode.ts";

const session = { token: "tok", tokenKind: "location", locationId: "loc-A" } as const;
let nextId = 0;

/** A fake GHL that creates records with fresh ids and deletes anything. */
function fakeAccount() {
  return createFakeGhl({
    "POST /contacts/": () => ({ status: 201, body: { contact: { id: `c${++nextId}` } } }),
    "*": (req: RecordedRequest) => {
      if (req.method === "DELETE") return { body: { succeded: true } };
      if (req.url.pathname.endsWith("/notes"))
        return { status: 201, body: { note: { id: `n${++nextId}` } } };
      if (req.url.pathname.endsWith("/tasks"))
        return { status: 201, body: { task: { id: `t${++nextId}` } } };
      if (req.url.pathname === "/opportunities/") {
        return { status: 201, body: { opportunity: { id: `o${++nextId}` } } };
      }
      return { body: {} };
    },
  });
}

function setup() {
  const ghl = fakeAccount();
  const ledger = memoryLedger();
  const writeGuard = createTestWriteGuard({ run: "run-1", ledger });
  const act = (operation: string, params = {}) =>
    performAction({ operation, params }, { session, fetch: ghl.fetch, writeGuard });
  const createContact = async () =>
    (
      (await act("contacts.create-contact", {
        body: { firstName: "Locus Test", lastName: "One", email: "one@example.com" },
      })) as { contact: { id: string } }
    ).contact.id;
  return { ghl, ledger, act, createContact };
}

describe("test-write mode", () => {
  test("creates fake contacts, tags them with the run, and records them", async () => {
    const { ghl, ledger, createContact } = setup();
    const id = await createContact();

    expect(ghl.requests[0]?.body).toMatchObject({
      firstName: "Locus Test",
      email: "one@example.com",
      tags: ["locus-test-run-1"],
      locationId: "loc-A",
    });
    expect(ledger.entries()).toMatchObject([{ run: "run-1", kind: "contact", id }]);
  });

  test("refuses contacts that could be real people, before anything is sent", async () => {
    const { ghl, act } = setup();
    const create = (body: Record<string, unknown>) => act("contacts.create-contact", { body });

    await expect(create({ firstName: "Jane", lastName: "Doe" })).rejects.toThrow(/Locus Test/);
    await expect(create({ firstName: "Locus Test", email: "jane@gmail.com" })).rejects.toThrow(
      /@example.com/,
    );
    await expect(create({ firstName: "Locus Test", phone: "+15555550100" })).rejects.toThrow(
      /phone/,
    );
    await expect(create({ firstName: "Locus Test", tags: ["reconnect lender"] })).rejects.toThrow(
      /could trigger a workflow/,
    );
    expect(ghl.requests).toHaveLength(0);
  });

  test("only touches records this run created", async () => {
    const { ghl, act, createContact } = setup();
    const mine = await createContact();
    const before = ghl.requests.length;

    await act("contacts.create-note", { path: { contactId: mine }, body: { body: "hi" } });
    await expect(
      act("contacts.create-note", { path: { contactId: "someone-real" }, body: { body: "hi" } }),
    ).rejects.toThrow(/not in the ledger/);
    await expect(
      act("contacts.update-contact", { path: { contactId: "someone-real" }, body: {} }),
    ).rejects.toThrow(/not in the ledger/);
    await expect(
      act("contacts.add-tags", { path: { contactId: mine }, body: { tags: ["vip"] } }),
    ).rejects.toThrow(/could trigger a workflow/);

    expect(ghl.requests.length - before).toBe(1);
  });

  test("opportunities need a test contact and a test name", async () => {
    const { act, createContact } = setup();
    const mine = await createContact();

    await expect(
      act("opportunities.create-opportunity", {
        body: { contactId: "someone-real", name: "Locus Test deal", pipelineId: "p1" },
      }),
    ).rejects.toThrow(/contacts this run created/);
    await expect(
      act("opportunities.create-opportunity", {
        body: { contactId: mine, name: "Big deal", pipelineId: "p1" },
      }),
    ).rejects.toThrow(/Locus Test/);
    await act("opportunities.create-opportunity", {
      body: { contactId: mine, name: "Locus Test deal", pipelineId: "p1" },
    });
  });

  test("refuses everything outside the allowed list", async () => {
    const { act, createContact } = setup();
    const mine = await createContact();

    await expect(
      act("contacts.add-contact-to-workflow", { path: { contactId: mine, workflowId: "w1" } }),
    ).rejects.toThrow(/not allowed against a real account/);
    await expect(
      act("locations.update-custom-value", { path: { id: "cv1" }, body: { value: "x" } }),
    ).rejects.toThrow(/not allowed/);
  });

  test("stops if a create returns no id, so nothing goes untracked", async () => {
    const ghl = createFakeGhl({ "POST /contacts/": { status: 201, body: { ok: true } } });
    const writeGuard = createTestWriteGuard({ run: "run-2", ledger: memoryLedger() });
    await expect(
      performAction(
        { operation: "contacts.create-contact", params: { body: { firstName: "Locus Test" } } },
        { session, fetch: ghl.fetch, writeGuard },
      ),
    ).rejects.toThrow(/returned no contact.id/);
  });

  test("cleanup deletes newest first, tolerates 404s and is safe to repeat", async () => {
    const { ghl, ledger, act, createContact } = setup();
    const contact = await createContact();
    await act("contacts.create-note", { path: { contactId: contact }, body: { body: "n" } });
    await act("contacts.create-task", {
      path: { contactId: contact },
      body: { title: "t", dueDate: "2030-01-01T00:00:00Z", completed: false },
    });

    const deletes = createFakeGhl({
      "*": (req: RecordedRequest) =>
        req.url.pathname.includes("/notes/")
          ? { status: 404, body: { statusCode: 404, message: "Not found" } }
          : { body: {} },
    });
    const report = await cleanupRun({ run: "run-1", ledger }, { session, fetch: deletes.fetch });

    expect(
      deletes.requests.map((r) => r.url.pathname.split("/").slice(3, 4)[0] ?? "contact"),
    ).toEqual(["tasks", "notes", "contact"]);
    expect(report.deleted.map((d) => d.kind)).toEqual(["task", "contact"]);
    expect(report.alreadyGone.map((d) => d.kind)).toEqual(["note"]);
    expect(report.failed).toEqual([]);

    const again = await cleanupRun({ run: "run-1", ledger }, { session, fetch: deletes.fetch });
    expect(again.deleted).toEqual([]);
    expect(ghl.requests.every((r) => r.method !== "DELETE")).toBe(true);
  });

  test("the file ledger survives a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "locus-ledger-")), "run.jsonl");
    fileLedger(path).append({ run: "run-3", kind: "contact", id: "c1", at: "now" });
    expect(fileLedger(path).entries()).toEqual([
      { run: "run-3", kind: "contact", id: "c1", at: "now" },
    ]);
  });

  test("rejects run ids that would make odd tags", () => {
    expect(() => createTestWriteGuard({ run: "Has Spaces", ledger: memoryLedger() })).toThrow();
  });
});
