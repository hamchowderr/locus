import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { appUserId, createComposioConnector } from "./composio.ts";

// A pretend Composio API: the real SDK runs against it, so this proves what Locus asks Composio
// for (which user, which apps, no sign-in links, no paid Instant accounts) with no key and no
// network.
interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
let server: Server;
let baseURL: string;
let seen: Seen[] = [];
let routes: Record<string, (body: Record<string, unknown> | undefined) => unknown> = {};

const read = async (req: IncomingMessage) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = await read(req);
    seen.push({ method: req.method ?? "", path, body });
    const route = routes[`${req.method} ${path}`];
    res.setHeader("content-type", "application/json");
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
      return;
    }
    res.end(JSON.stringify(route(body)));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const SESSION = "/api/v3.1/tool_router/session";

beforeEach(() => {
  seen = [];
  routes = {
    [`POST ${SESSION}`]: () => ({
      session_id: "trs_1",
      mcp: { type: "http", url: `${baseURL}/mcp/trs_1` },
      tool_router_tools: [],
      config: { user_id: "locus-client:client-1" },
    }),
  };
});

const connector = () =>
  createComposioConnector({ apiKey: "test-key", clientId: "client-1", baseURL });

describe("Composio connector", () => {
  test("opens one session for the client, with Locus's apps only and no sign-in links", async () => {
    routes[`POST ${SESSION}/trs_1/execute`] = () => ({
      data: { messages: [] },
      error: null,
      log_id: "log_1",
      result_type: "completed",
    });
    const apps = connector();
    await apps.execute("GMAIL_FETCH_EMAILS", { max_results: 1 });
    await apps.execute("GMAIL_FETCH_EMAILS", {});

    const created = seen.filter((s) => s.path === SESSION);
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({
      user_id: appUserId("client-1"),
      toolkits: { enable: ["gmail", "googlecalendar", "slack"] },
      manage_connections: { enable: false },
      // Never a Composio-owned account, which Composio bills for.
      instant: false,
    });
    expect(seen.filter((s) => s.path.endsWith("/execute")).map((s) => s.body)).toEqual([
      expect.objectContaining({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }),
      expect.objectContaining({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }),
    ]);
  });

  test("search lists tools with their arguments, and which apps aren't connected", async () => {
    routes[`POST ${SESSION}/trs_1/search`] = (body) => {
      expect(body).toMatchObject({ queries: [{ use_case: "read my email" }] });
      return {
        success: true,
        error: null,
        results: [
          {
            index: 0,
            use_case: "read my email",
            primary_tool_slugs: ["GMAIL_FETCH_EMAILS"],
            related_tool_slugs: ["GMAIL_GET_PROFILE"],
            toolkits: ["gmail"],
          },
        ],
        tool_schemas: {
          GMAIL_FETCH_EMAILS: {
            tool_slug: "GMAIL_FETCH_EMAILS",
            toolkit: "gmail",
            description: "Fetch emails",
            input_schema: { type: "object", properties: { max_results: { type: "integer" } } },
          },
        },
        toolkit_connection_statuses: [
          {
            toolkit: "gmail",
            description: "Gmail",
            has_active_connection: true,
            status_message: "",
          },
          {
            toolkit: "slack",
            description: "Slack",
            has_active_connection: false,
            status_message: "",
          },
        ],
        next_steps_guidance: [],
        session: { id: "trs_1", generate_id: false, instructions: "" },
        time_info: {
          current_time_utc: "2026-10-20T00:00:00Z",
          current_time_utc_epoch_seconds: 1_792_454_400,
          message: "",
        },
      };
    };

    const found = await connector().search("read my email");

    // A tool Composio named without a schema isn't offered: the model couldn't call it right.
    expect(found).toEqual({
      tools: [
        {
          slug: "GMAIL_FETCH_EMAILS",
          toolkit: "gmail",
          description: "Fetch emails",
          inputSchema: { type: "object", properties: { max_results: { type: "integer" } } },
        },
      ],
      notConnected: ["slack"],
    });
  });

  test("a tool counts as read-only only when Composio tags it so, and the answer is kept", async () => {
    const tool = (slug: string, tags: string[]) => ({
      slug,
      name: slug,
      description: "",
      tags,
      toolkit: { slug: slug.split("_")[0]?.toLowerCase(), name: "", logo: "" },
      input_parameters: {},
      output_parameters: {},
      available_versions: [],
      version: "1",
      no_auth: false,
      is_deprecated: false,
      deprecated: {
        displayName: slug,
        version: "1",
        available_versions: [],
        toolkit: { logo: "" },
        is_deprecated: false,
      },
    });
    routes["GET /api/v3.1/tools/GMAIL_FETCH_EMAILS"] = () =>
      tool("GMAIL_FETCH_EMAILS", ["readOnlyHint", "idempotentHint"]);
    routes["GET /api/v3.1/tools/GMAIL_SEND_EMAIL"] = () =>
      tool("GMAIL_SEND_EMAIL", ["openWorldHint"]);
    const apps = connector();

    expect(await apps.readOnly("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(await apps.readOnly("GMAIL_SEND_EMAIL")).toBe(false);
    expect(await apps.readOnly("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(seen.filter((s) => s.path.startsWith("/api/v3.1/tools/"))).toHaveLength(2);
  });

  test("a tool that ran and failed comes back as an error the model can read", async () => {
    routes[`POST ${SESSION}/trs_1/execute`] = () => ({
      data: {},
      error: "Recipient address rejected",
      log_id: "log_2",
      result_type: "failed",
    });
    expect(await connector().execute("GMAIL_SEND_EMAIL", { to: "x" })).toEqual({
      ok: false,
      error: "Recipient address rejected",
    });
  });

  test("a session that failed to open is opened again on the next call", async () => {
    let fail = true;
    const open = routes[`POST ${SESSION}`];
    routes[`POST ${SESSION}`] = (body) => {
      if (fail) {
        fail = false;
        return { error: { message: "down" } };
      }
      return open?.(body);
    };
    routes[`POST ${SESSION}/trs_1/execute`] = () => ({
      data: {},
      error: null,
      log_id: "log_3",
      result_type: "completed",
    });
    const apps = connector();
    await expect(apps.execute("GMAIL_FETCH_EMAILS", {})).rejects.toThrow();
    expect(await apps.execute("GMAIL_FETCH_EMAILS", {})).toEqual({ ok: true, data: {} });
  });

  test("a client id is required to name the Composio user", () => {
    expect(() => appUserId("")).toThrow(/need a client/);
    expect(appUserId("c1")).toBe("locus-client:c1");
  });
});
