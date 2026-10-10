import type { GhlSession } from "@locus/ghl";
import { createFakeGhl, type RecordedRequest } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { QueryError, runQuery } from "./query-data.ts";

const session: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-A" };

/** A list endpoint over `items` that honours limit + skip or page + limit like GHL does. */
function paged(field: string, items: Record<string, unknown>[], style: "skip" | "page") {
  return (req: RecordedRequest) => {
    const q = req.url.searchParams;
    const limit = Number(q.get("limit") ?? 20);
    const start =
      style === "skip" ? Number(q.get("skip") ?? 0) : (Number(q.get("page")) - 1) * limit;
    return { body: { [field]: items.slice(start, start + limit), total: items.length } };
  };
}

const forms = Array.from({ length: 5 }, (_, i) => ({
  id: `f${i}`,
  name: `Form ${i}`,
  type: i % 2 ? "survey" : "form",
}));
const opportunities = [
  { id: "o1", contactId: "c1", status: "open", monetaryValue: 500 },
  { id: "o2", contactId: "c2", status: "won", monetaryValue: 1200 },
  { id: "o3", contactId: "c1", status: "open", monetaryValue: 300 },
];

describe("runQuery", () => {
  test("pages through an offset source to the end and answers in SQL", async () => {
    const ghl = createFakeGhl({ "GET /forms/": paged("forms", forms, "skip") });

    const result = await runQuery(
      {
        sources: [{ as: "forms", operation: "forms.get-forms" }],
        sql: "SELECT type, COUNT(*) AS n FROM forms GROUP BY type ORDER BY type",
      },
      { session, fetch: ghl.fetch, limits: { pageSize: 2 } },
    );

    expect(result.rows).toEqual([
      { type: "form", n: 3 },
      { type: "survey", n: 2 },
    ]);
    expect(result.sources).toEqual([
      { as: "forms", operation: "forms.get-forms", rows: 5, requests: 3, complete: true },
    ]);
    expect(ghl.requests.map((r) => r.url.searchParams.get("skip"))).toEqual(["0", "2", "4"]);
    expect(ghl.requests.every((r) => r.url.searchParams.get("locationId") === "loc-A")).toBe(true);
  });

  test("pages a page-numbered source and chains IDs into a second source", async () => {
    const ghl = createFakeGhl({
      "GET /opportunities/search": paged("opportunities", opportunities, "page"),
      "GET /contacts/c1": { body: { contact: { id: "c1", firstName: "Ada" } } },
      "GET /contacts/c2": { body: { contact: { id: "c2", firstName: "Grace" } } },
    });

    const result = await runQuery(
      {
        sources: [
          {
            as: "opps",
            operation: "opportunities.search-opportunity",
            params: { query: { status: "all" } },
          },
          {
            as: "people",
            operation: "contacts.get-contact",
            forEach: { from: "opps", column: "contactId", param: "contactId" },
          },
        ],
        sql: `SELECT p.firstName, SUM(o.monetaryValue) AS pipeline
              FROM opps o JOIN people p ON p._key = o.contactId
              GROUP BY p.firstName ORDER BY pipeline DESC`,
      },
      { session, fetch: ghl.fetch, limits: { pageSize: 2 } },
    );

    expect(result.rows).toEqual([
      { firstName: "Grace", pipeline: 1200 },
      { firstName: "Ada", pipeline: 800 },
    ]);
    // Two contacts fetched once each, though c1 appears twice upstream.
    expect(result.sources[1]).toMatchObject({ rows: 2, requests: 2, complete: true });
  });

  test("refuses writes, unknown operations and paging parameters it owns", async () => {
    const deps = { session, fetch: createFakeGhl({}).fetch };
    const one = (operation: string, params = {}) =>
      runQuery({ sources: [{ as: "t", operation, params }], sql: "SELECT 1" }, deps);

    await expect(one("contacts.create-contact")).rejects.toThrow(/use perform_action/);
    await expect(one("contacts.nope")).rejects.toThrow(/unknown operation/);
    await expect(one("forms.get-forms", { query: { skip: 10 } })).rejects.toThrow(
      /pages forms.get-forms itself; remove skip/,
    );
  });

  test("says a chain is not composable instead of guessing", async () => {
    const ghl = createFakeGhl({ "GET /opportunities/search": { body: { opportunities } } });
    const query = runQuery(
      {
        sources: [
          { as: "opps", operation: "opportunities.search-opportunity" },
          {
            as: "people",
            operation: "contacts.get-contact",
            forEach: { from: "opps", column: "contactId", param: "personId" },
          },
        ],
        sql: "SELECT 1",
      },
      { session, fetch: ghl.fetch },
    );
    await expect(query).rejects.toThrow(
      /not composable: contacts.get-contact takes no parameter "personId"/,
    );
  });

  test("fails loudly when a source needs too many requests or too wide a fan-out", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, contactId: `c${i}` }));
    const ghl = createFakeGhl({
      "GET /forms/": paged("forms", many, "skip"),
      "*": { body: { contact: { id: "x" } } },
    });

    await expect(
      runQuery(
        { sources: [{ as: "forms", operation: "forms.get-forms" }], sql: "SELECT 1" },
        { session, fetch: ghl.fetch, limits: { pageSize: 2, maxRequestsPerSource: 5 } },
      ),
    ).rejects.toThrow(/needs more than 5 requests/);

    await expect(
      runQuery(
        {
          sources: [
            { as: "forms", operation: "forms.get-forms" },
            {
              as: "people",
              operation: "contacts.get-contact",
              forEach: { from: "forms", column: "contactId", param: "contactId" },
            },
          ],
          sql: "SELECT 1",
        },
        { session, fetch: ghl.fetch, limits: { maxFanOut: 10 } },
      ),
    ).rejects.toThrow(/30 times \(limit 10\)/);
  });

  test("marks a source incomplete when it cannot page it, instead of pretending", async () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    const ghl = createFakeGhl({
      "GET /conversations/messages/export": { body: { messages, nextCursor: "abc" } },
      "POST /contacts/search": { body: { contacts: [{ id: "c1" }], total: 900 } },
    });

    const result = await runQuery(
      {
        sources: [
          { as: "messages", operation: "conversations.export-messages-by-location" },
          { as: "found", operation: "contacts.search-contacts-advanced", params: { body: {} } },
        ],
        sql: "SELECT (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM found) AS c",
      },
      { session, fetch: ghl.fetch },
    );

    expect(result.rows).toEqual([{ m: 100, c: 1 }]);
    expect(result.sources.map((s) => s.complete)).toEqual([false, false]);
    expect(result.sources[0]?.note).toMatch(/cursor/);
    expect(result.sources[1]?.note).toMatch(/undocumented paging/);
  });

  test("picks the rows field, and asks when the response has several lists", async () => {
    const ghl = createFakeGhl({
      "GET /forms/": { body: { forms: [{ id: "f1" }], archived: [{ id: "f0" }] } },
    });
    const query = (rowsField?: string) =>
      runQuery(
        {
          sources: [
            { as: "forms", operation: "forms.get-forms", ...(rowsField ? { rowsField } : {}) },
          ],
          sql: "SELECT id FROM forms",
        },
        { session, fetch: ghl.fetch },
      );

    await expect(query()).rejects.toThrow(/several lists \(forms, archived\); set rowsField/);
    expect((await query("archived")).rows).toEqual([{ id: "f0" }]);
  });

  test("runs one SELECT and caps what it returns", async () => {
    const ghl = createFakeGhl({ "GET /forms/": paged("forms", forms, "skip") });
    const query = (sql: string) =>
      runQuery(
        { sources: [{ as: "forms", operation: "forms.get-forms" }], sql },
        { session, fetch: ghl.fetch, limits: { maxResultRows: 2 } },
      );

    await expect(query("DELETE FROM forms")).rejects.toBeInstanceOf(QueryError);
    await expect(query("SELECT 1; SELECT 2")).rejects.toThrow(/single statement/);
    await expect(query("SELECT nope FROM forms")).rejects.toThrow(/sql failed/);

    const capped = await query("SELECT id FROM forms ORDER BY id");
    expect(capped).toMatchObject({
      rowCount: 5,
      truncated: true,
      rows: [{ id: "f0" }, { id: "f1" }],
    });
  });
});
