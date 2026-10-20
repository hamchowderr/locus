import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  tokens: ["location"],
  scopes: ["opportunities.readonly"],
  sessionParams: [{ in: "query", name: "locationId", value: "locationId", required: true }],
});

const getContact = defineOperation({
  id: "contacts.get-contact",
  method: "GET",
  path: "/contacts/{contactId}",
  version: "v3",
  tokens: ["location"],
  scopes: ["contacts.readonly"],
});

const deleteFacebookPage = defineOperation({
  id: "ad-publishing.fb-delete-page-v4",
  method: "DELETE",
  path: "/ad-publishing/facebook/pages/{pageId}",
  version: "v4",
  tokens: ["location"],
  scopes: [],
});

const listInvoices = defineOperation({
  id: "invoices.list-invoices",
  method: "GET",
  path: "/invoices/",
  version: "v3",
  tokens: ["location", "agency"],
  scopes: ["invoices.readonly"],
  sessionParams: [
    { in: "query", name: "altId", value: "locationId", required: true },
    { in: "query", name: "altType", value: "altType", required: true },
  ],
});

const getAccessToken = defineOperation({
  id: "oauth.get-access-token",
  method: "POST",
  path: "/oauth/token",
  version: "v3",
  tokens: [],
  scopes: [],
  body: "form",
});

const uploadMedia = defineOperation({
  id: "medias.upload-media-content",
  method: "POST",
  path: "/medias/upload-file",
  version: "v3",
  tokens: ["location"],
  scopes: ["medias.write"],
  body: "multipart",
});

const listCompanyUsers = defineOperation({
  id: "users.search-users",
  method: "GET",
  path: "/users/search",
  version: "v3",
  tokens: ["agency"],
  scopes: ["users.readonly"],
  sessionParams: [
    { in: "query", name: "companyId", value: "companyId", required: true },
    { in: "query", name: "locationId", value: "locationId", required: false },
  ],
});

const publicTemplates = defineOperation({
  id: "courses.public-import",
  method: "POST",
  path: "/courses/courses-exporter/public/import",
  version: "v3",
  tokens: [],
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

  test("fills altId and altType from the session and refuses them from the caller", async () => {
    const ghl = createFakeGhl({ "GET /invoices/": { body: { invoices: [] } } });

    await ghlRequest(listInvoices, session, { query: { limit: 10 } }, ghl);
    const params = ghl.requests[0]?.url.searchParams;
    expect(params?.get("altId")).toBe("loc-A");
    expect(params?.get("altType")).toBe("location");

    await expect(
      ghlRequest(listInvoices, session, { query: { altId: "loc-B" } }, ghl),
    ).rejects.toThrow(/altId comes from the session/);
  });

  test("accepts any token kind the operation lists, and fills companyId for agencies", async () => {
    const ghl = createFakeGhl({
      "GET /invoices/": { body: {} },
      "GET /users/search": { body: {} },
    });
    const agency = { token: "tok-agency", tokenKind: "agency", companyId: "co-1" } as const;

    await ghlRequest(listInvoices, { ...agency, locationId: "loc-A" }, {}, ghl);
    await ghlRequest(listCompanyUsers, agency, {}, ghl);

    const users = ghl.requests[1]?.url.searchParams;
    expect(users?.get("companyId")).toBe("co-1");
    expect(users?.has("locationId")).toBe(false);
  });

  test("sends no Authorization header to an operation that takes no auth", async () => {
    const ghl = createFakeGhl({ "POST /courses/courses-exporter/public/import": { body: {} } });

    await ghlRequest(publicTemplates, session, { body: { url: "x" } }, ghl);

    expect(ghl.requests[0]?.headers.authorization).toBeUndefined();
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

  test("sends form-encoded bodies as form fields, with no Authorization header", async () => {
    const ghl = createFakeGhl({ "POST /oauth/token": { body: { access_token: "t" } } });
    await ghlRequest(
      getAccessToken,
      { token: "", tokenKind: "agency" },
      {
        body: {
          client_id: "id",
          grant_type: "authorization_code",
          code: "c&d",
          redirect_uri: undefined,
        },
      },
      { fetch: ghl.fetch },
    );
    const [req] = ghl.requests;
    expect(req?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.body).toEqual({ client_id: "id", grant_type: "authorization_code", code: "c&d" });
  });

  test("sends files and fields as multipart, with its boundary and exact length", async () => {
    const ghl = createFakeGhl({ "POST /medias/upload-file": { body: { fileId: "f1", url: "u" } } });
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
    const out = await ghlRequest(
      uploadMedia,
      { token: "t", tokenKind: "location", locationId: "loc" },
      { body: { file, name: "photo.png", parentId: "folder" } },
      { fetch: ghl.fetch },
    );
    expect(out).toEqual({ fileId: "f1", url: "u" });
    const [req] = ghl.requests;
    expect(req?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const form = req?.body as FormData;
    expect(form.get("name")).toBe("photo.png");
    expect(form.get("parentId")).toBe("folder");
    expect((form.get("file") as File).name).toBe("photo.png");
    expect((form.get("file") as File).size).toBe(3);
  });

  test("streams a multipart body to a real server with its length, not chunked", async () => {
    const received: {
      headers: Record<string, unknown>;
      bytes: number;
      form?: FormData | undefined;
    } = {
      headers: {},
      bytes: 0,
    };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const all = Buffer.concat(chunks);
      received.headers = req.headers;
      received.bytes = all.length;
      received.form = await new Response(all, {
        headers: { "content-type": String(req.headers["content-type"]) },
      })
        .formData()
        .catch(() => undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ fileId: "f1", url: "u" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
      const file = new File([bytes], 'a "quoted"\r\nname.mp4', { type: "video/mp4" });
      await ghlRequest(
        uploadMedia,
        { token: "t", tokenKind: "location", locationId: "loc" },
        { body: { file, name: "clip", parentId: "folder" } },
        { baseUrl: `http://127.0.0.1:${port}` },
      );
      expect(received.headers["transfer-encoding"]).toBeUndefined();
      expect(Number(received.headers["content-length"])).toBe(received.bytes);
      const sent = received.form?.get("file") as File;
      expect(sent.type).toBe("video/mp4");
      expect(new Uint8Array(await sent.arrayBuffer())).toEqual(bytes);
      expect(received.form?.get("name")).toBe("clip");
      expect(received.form?.get("parentId")).toBe("folder");
    } finally {
      server.close();
    }
  }, 20_000);

  test("refuses nested values in form and multipart bodies, before sending", async () => {
    const ghl = createFakeGhl({});
    await expect(
      ghlRequest(
        getAccessToken,
        { token: "", tokenKind: "agency" },
        { body: { a: { b: 1 } } },
        { fetch: ghl.fetch },
      ),
    ).rejects.toBeInstanceOf(GhlUsageError);
    await expect(
      ghlRequest(
        uploadMedia,
        { token: "t", tokenKind: "location" },
        { body: { meta: { a: 1 } } },
        { fetch: ghl.fetch },
      ),
    ).rejects.toBeInstanceOf(GhlUsageError);
    expect(ghl.requests).toHaveLength(0);
  });
});
