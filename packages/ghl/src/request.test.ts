import { createFakeGhl } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { defineOperation } from "./operation.ts";
import { GhlError, GhlUsageError, ghlRequest } from "./request.ts";

// Real operations, as described by GHL's live v3 docs.
const searchOpportunities = defineOperation({
  id: "opportunities.search-opportunity",
  method: "GET",
  path: "/opportunities/search",
  version: "v3",
  token: "location",
  scopes: ["opportunities.readonly"],
  location: { in: "query", name: "locationId" },
});

const getContact = defineOperation({
  id: "contacts.get-contact",
  method: "GET",
  path: "/contacts/{contactId}",
  version: "v3",
  token: "location",
  scopes: ["contacts.readonly"],
});

const deleteFacebookPage = defineOperation({
  id: "ad-publishing.fb-delete-page-v4",
  method: "DELETE",
  path: "/ad-publishing/facebook/pages/{pageId}",
  version: "v4",
  token: "location",
  scopes: [],
});

const session = { token: "tok-client-a", tokenKind: "location", locationId: "loc-A" } as const;

describe("ghlRequest", () => {
  test("sends the version each operation declares, not a global one", async () => {
    const ghl = createFakeGhl({
      "GET /contacts/c1": { body: { contact: { id: "c1" } } },
      "DELETE /ad-publishing/facebook/pages/p1": { body: {} },
    });

    await ghlRequest(getContact, session, { path: { contactId: "c1" } }, { fetch: ghl.fetch });
    await ghlRequest(deleteFacebookPage, session, { path: { pageId: "p1" } }, ghl);

    expect(ghl.requests.map((r) => r.headers.version)).toEqual(["v3", "v4"]);
  });

  test("fills locationId from the session", async () => {
    const ghl = createFakeGhl({ "GET /opportunities/search": { body: { opportunities: [] } } });

    await ghlRequest(searchOpportunities, session, { query: { status: "open" } }, ghl);

    const [req] = ghl.requests;
    expect(req?.url.searchParams.get("locationId")).toBe("loc-A");
    expect(req?.url.searchParams.get("status")).toBe("open");
    expect(req?.headers.authorization).toBe("Bearer tok-client-a");
  });

  test("refuses a locationId supplied by the caller, before sending anything", async () => {
    const ghl = createFakeGhl({});

    await expect(
      ghlRequest(searchOpportunities, session, { query: { locationId: "loc-B" } }, ghl),
    ).rejects.toBeInstanceOf(GhlUsageError);
    expect(ghl.requests).toHaveLength(0);
  });

  test("refuses an operation that names a client when the session names none", async () => {
    const agencyless = { token: "t", tokenKind: "location" } as const;
    await expect(ghlRequest(searchOpportunities, agencyless)).rejects.toThrow(/names none/);
  });

  test("refuses the wrong token kind", async () => {
    const agency = { token: "t", tokenKind: "agency" } as const;
    await expect(ghlRequest(getContact, agency, { path: { contactId: "c1" } })).rejects.toThrow(
      /needs a location token/,
    );
  });

  test("checks and encodes path parameters", async () => {
    const ghl = createFakeGhl({ "GET /contacts/a%2Fb": { body: {} } });

    await expect(ghlRequest(getContact, session, {}, ghl)).rejects.toThrow(/contactId/);
    await expect(
      ghlRequest(getContact, session, { path: { contactId: "c1", other: "x" } }, ghl),
    ).rejects.toThrow(/other/);

    await ghlRequest(getContact, session, { path: { contactId: "a/b" } }, ghl);
    expect(ghl.requests.at(-1)?.url.pathname).toBe("/contacts/a%2Fb");
  });

  test("normalises both GHL error shapes", async () => {
    const ghl = createFakeGhl({
      "GET /contacts/missing": { status: 404, body: { statusCode: 404, message: "Not found" } },
      "GET /contacts/aip": {
        status: 400,
        body: { error: { code: "INVALID_ARGUMENT", message: "bad id", details: [] } },
      },
    });

    const plain = ghlRequest(getContact, session, { path: { contactId: "missing" } }, ghl);
    await expect(plain).rejects.toMatchObject({ status: 404, message: /Not found/ });

    const aip = ghlRequest(getContact, session, { path: { contactId: "aip" } }, ghl);
    await expect(aip).rejects.toBeInstanceOf(GhlError);
    await expect(aip).rejects.toMatchObject({ status: 400, code: "INVALID_ARGUMENT" });
  });
});
