import { describe, expect, test } from "vitest";
import { DocsParseError, parseDocs } from "./parse.ts";

// A trimmed export in GHL's exact layout, one endpoint per case the parser must handle.
const EXPORT = `# HighLevel API v3: full reference

> Every endpoint of HighLevel API version v3.

## Services

- widgets (5)

## Service: widgets (Widgets API v3)

### Get Widget
GET /widgets/{widgetId}
URL: https://services.leadconnectorhq.com/widgets/{widgetId}
Docs: https://marketplace.gohighlevel.com/docs/ghl/widgets/get-widget | Markdown: https://marketplace.gohighlevel.com/docs/ghl/widgets/get-widget.md

Get a widget by id. Second sentence.

Auth: Sub-Account token: OAuth access token or Private Integration Token. Scopes: widgets.readonly

Headers:
- Authorization: Bearer <token> (required)
- Version: v3 (required)

Path parameters:
- widgetId* string (e.g. "w1") - Widget id

Response 200 (Success): no body

### List Widgets
GET /widgets/
URL: https://services.leadconnectorhq.com/widgets/
Docs: https://marketplace.gohighlevel.com/docs/ghl/widgets/list-widgets | Markdown: x

Deprecated: use the search endpoint.

Auth (any one of):
- Sub-Account token: OAuth access token or Private Integration Token. Scopes: widgets.readonly
- Agency token: OAuth access token only (Private Integration Tokens are not accepted). Scopes: widgets.list

Headers:
- Authorization: Bearer <token> (required)
- Version: v3 (required)

Query parameters:
- altId* string - location Id
- altType* string (enum: location) - Alt Type
- limit number (default: 20) - Page size
- skip number - Rows to skip

### Create Widget
POST /widgets/{locationId}/items/{itemId}
URL: x
Docs: https://marketplace.gohighlevel.com/docs/ghl/widgets/create-widget | Markdown: x

Create one.

Auth: Agency token: OAuth access token or Private Integration Token. Scopes: widgets.write

Headers:
- Authorization: Bearer <token> (required)
- Version: v3 (required)

Path parameters:
- locationId* string - Location

Request body (required) (application/json) CreateWidgetDto:
- name* string - Name
- companyId* string - Agency
- settings object - Settings
  - locationId string - nested, not a session parameter

Response 201 (Created): no body

### Upload Widget Image
POST /widgets/upload
URL: x
Docs: https://marketplace.gohighlevel.com/docs/ghl/widgets/upload-widget-image | Markdown: x

Auth: Sub-Account token: OAuth access token or Private Integration Token. Scopes: widgets.write

Headers:
- Authorization: Bearer <token> (required)
- Version: v3 (required)

Request body (required) (multipart/form-data):
- file* string (format: binary) - The image

### Public Widget Feed
GET /widgets/public/feed
URL: x
Docs: https://marketplace.gohighlevel.com/docs/ghl/widgets/public-widget-feed | Markdown: x

Auth: none (no security requirement declared; send no Authorization header)

Headers:
- Version: v3 (required)
`;

describe("parseDocs", () => {
  const docs = parseDocs(EXPORT);
  const [service] = docs.services;
  const op = (slug: string) => service?.operations.find((o) => o.id === `widgets.${slug}`);

  test("reads the version, services and every endpoint", () => {
    expect(docs.version).toBe("v3");
    expect(service).toMatchObject({ name: "widgets", label: "Widgets API v3" });
    expect(service?.operations.map((o) => o.id)).toEqual([
      "widgets.get-widget",
      "widgets.list-widgets",
      "widgets.create-widget",
      "widgets.upload-widget-image",
      "widgets.public-widget-feed",
    ]);
    expect(service?.reference.startsWith("## Service: widgets")).toBe(true);
  });

  test("reads method, path, version, scopes and the first sentence", () => {
    expect(op("get-widget")).toMatchObject({
      title: "Get Widget",
      summary: "Get a widget by id.",
      method: "GET",
      path: "/widgets/{widgetId}",
      version: "v3",
      tokens: ["location"],
      scopes: ["widgets.readonly"],
      sessionParams: [],
      deprecated: false,
    });
    expect(op("get-widget")?.body).toBeUndefined();
  });

  test("merges 'any one of' auth and spots deprecation", () => {
    expect(op("list-widgets")).toMatchObject({
      tokens: ["agency", "location"],
      scopes: ["widgets.list", "widgets.readonly"],
      deprecated: true,
    });
  });

  test("records caller query parameters and the pagination style", () => {
    expect(op("list-widgets")).toMatchObject({
      queryParams: ["limit", "skip"],
      pagination: { style: "offset", in: "query", limit: "limit", offset: "skip" },
    });
    expect(op("get-widget")?.pagination).toBeUndefined();
  });

  test("marks altId + altType as session parameters", () => {
    expect(op("list-widgets")?.sessionParams).toEqual([
      { in: "query", name: "altId", value: "locationId", required: true },
      { in: "query", name: "altType", value: "altType", required: true },
    ]);
  });

  test("finds session parameters in path and top-level body only", () => {
    expect(op("create-widget")).toMatchObject({ tokens: ["agency"], body: "json" });
    expect(op("create-widget")?.sessionParams).toEqual([
      { in: "path", name: "locationId", value: "locationId", required: true },
      { in: "body", name: "companyId", value: "companyId", required: true },
    ]);
  });

  test("records an undocumented path parameter as a warning, not a failure", () => {
    expect(docs.warnings).toEqual([
      'widgets / "Create Widget": path parameter {itemId} is undocumented',
    ]);
  });

  test("records non-JSON bodies and operations without auth", () => {
    expect(op("upload-widget-image")?.body).toBe("multipart");
    expect(op("public-widget-feed")).toMatchObject({ tokens: [], scopes: [] });
  });

  test("fails loudly on anything it does not recognise", () => {
    expect(() => parseDocs("# Something else")).toThrow(DocsParseError);
    expect(() => parseDocs(EXPORT.replace("GET /widgets/{widgetId}", "FETCH /widgets"))).toThrow(
      /unknown method FETCH/,
    );
    expect(() => parseDocs(EXPORT.replace("- Version: v3 (required)", "- Version: v9"))).toThrow(
      /unknown version v9/,
    );
    expect(() =>
      parseDocs(EXPORT.replace("list-widgets | Markdown", "get-widget | Markdown")),
    ).toThrow(/duplicate operation id widgets.get-widget/);
  });
});
