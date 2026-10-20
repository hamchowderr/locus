import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AppServiceError } from "./apps.ts";
import { appUserId, createComposioConnections, createComposioConnector } from "./composio.ts";

// A pretend Composio API: the real SDK runs against it, so this proves what Locus asks Composio
// for (which user, which apps, no sign-in links, no paid Instant accounts) with no key and no
// network.
interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
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
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const body = await read(req);
    seen.push({ method: req.method ?? "", path, query: url.searchParams, body });
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

/** A search answer as Composio sends it. */
const searchBody = () => ({
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
});

/** A tool as Composio describes it. */
const toolBody = (slug: string, tags: string[]) => ({
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
      return searchBody();
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
    routes["GET /api/v3.1/tools/GMAIL_FETCH_EMAILS"] = () =>
      toolBody("GMAIL_FETCH_EMAILS", ["readOnlyHint", "idempotentHint"]);
    routes["GET /api/v3.1/tools/GMAIL_SEND_EMAIL"] = () =>
      toolBody("GMAIL_SEND_EMAIL", ["openWorldHint"]);
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

  test("Composio's own errors come back as service errors, and the session is opened again", async () => {
    // No execute route: the pretend API answers 404, as for a lost session.
    const apps = connector();
    const failed = apps.execute("GMAIL_FETCH_EMAILS", {});
    await expect(failed).rejects.toThrow(AppServiceError);
    await expect(failed).rejects.toThrow(/^Composio: /);
    routes[`POST ${SESSION}/trs_1/execute`] = () => ({
      data: {},
      error: null,
      log_id: "log_4",
      result_type: "completed",
    });
    expect(await apps.execute("GMAIL_FETCH_EMAILS", {})).toEqual({ ok: true, data: {} });
    expect(seen.filter((s) => s.path === SESSION)).toHaveLength(2);
  });

  test("a failed search says so, rather than finding nothing", async () => {
    routes[`POST ${SESSION}/trs_1/search`] = () => ({
      ...searchBody(),
      success: false,
      error: "toolkit index unavailable",
    });
    await expect(connector().search("email")).rejects.toThrow(
      "Composio: toolkit index unavailable",
    );
  });

  test("a tool from another toolkit never counts as read-only", async () => {
    routes["GET /api/v3.1/tools/GMAIL_SNEAKY"] = () => ({
      ...toolBody("GMAIL_SNEAKY", ["readOnlyHint"]),
      toolkit: { slug: "github", name: "", logo: "" },
    });
    expect(await connector().readOnly("GMAIL_SNEAKY")).toBe(false);
  });
});

describe("Composio connections", () => {
  const connections = () => createComposioConnections({ apiKey: "test-key", baseURL });
  const toolkitsBody = (gmail: "ACTIVE" | null) => ({
    items: [
      {
        slug: "gmail",
        name: "Gmail",
        is_no_auth: false,
        meta: { logo: "" },
        connected_account: gmail
          ? {
              id: "ca_gmail",
              status: gmail,
              auth_config: { id: "ac_1", auth_scheme: "OAUTH2", is_composio_managed: true },
            }
          : null,
      },
      {
        slug: "slack",
        name: "Slack",
        is_no_auth: false,
        meta: { logo: "" },
        connected_account: null,
      },
    ],
    next_cursor: null,
    total_pages: 1,
  });

  const ACCOUNTS = "/api/v3.1/connected_accounts";
  /** The client's accounts for an app as Composio lists them, `next` naming a further page. */
  const accountsBody = (accounts: [id: string, status: string][], next: string | null = null) => ({
    items: accounts.map(([id, status]) => ({
      id,
      status,
      status_reason: null,
      is_disabled: false,
      created_at: "2026-10-20T00:00:00Z",
      updated_at: "2026-10-20T00:00:00Z",
      toolkit: { slug: "gmail" },
      auth_config: {
        id: "ac_1",
        auth_scheme: "OAUTH2",
        is_composio_managed: true,
        is_disabled: false,
      },
      data: {},
      params: {},
    })),
    next_cursor: next,
    total_pages: next ? 2 : 1,
  });
  const deleted = () =>
    seen.filter((s) => s.method === "DELETE").map((s) => s.path.slice(ACCOUNTS.length + 1));

  test("lists Locus's apps for the client, connected or not", async () => {
    routes[`GET ${SESSION}/trs_1/toolkits`] = () => toolkitsBody("ACTIVE");
    expect(await connections().list("client-1")).toEqual([
      { toolkit: "gmail", name: "Gmail", connected: true },
      { toolkit: "googlecalendar", name: "googlecalendar", connected: false },
      { toolkit: "slack", name: "Slack", connected: false },
    ]);
    expect(seen.find((s) => s.path === SESSION)?.body).toMatchObject({
      user_id: appUserId("client-1"),
    });
  });

  test("connecting gives the app's sign-in link, coming back to Locus", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([]);
    routes[`POST ${SESSION}/trs_1/link`] = (body) => {
      expect(body).toMatchObject({ toolkit: "gmail", callback_url: "https://locus.test/apps" });
      return { connected_account_id: "ca_new", redirect_url: "https://accounts.google.test/o" };
    };
    expect(await connections().connect("client-1", "gmail", "https://locus.test/apps")).toBe(
      "https://accounts.google.test/o",
    );
  });

  test("only apps Locus offers can be connected or disconnected", async () => {
    await expect(connections().connect("client-1", "github", "https://x")).rejects.toThrow(
      AppServiceError,
    );
    await expect(connections().disconnect("client-1", "github")).rejects.toThrow(AppServiceError);
    expect(seen).toEqual([]);
  });

  test("disconnecting deletes every account the client has for that app, found by Locus", async () => {
    routes[`GET ${ACCOUNTS}`] = () => {
      const listed = seen.filter((s) => s.path === ACCOUNTS);
      return listed.length === 1
        ? accountsBody([["ca_gmail", "ACTIVE"]], "page-2")
        : accountsBody([["ca_second", "ACTIVE"]]);
    };
    routes[`DELETE ${ACCOUNTS}/ca_gmail`] = () => ({ success: true });
    routes[`DELETE ${ACCOUNTS}/ca_second`] = () => ({ success: true });
    await connections().disconnect("client-1", "GMAIL");
    const lists = seen.filter((s) => s.path === ACCOUNTS);
    for (const list of lists) {
      expect(list.query.getAll("user_ids").join(",")).toContain(appUserId("client-1"));
      expect(list.query.getAll("toolkit_slugs").join(",")).toContain("gmail");
    }
    expect(lists[1]?.query.get("cursor")).toBe("page-2");
    expect(deleted()).toEqual(["ca_gmail", "ca_second"]);
  });

  test("disconnecting an app that isn't connected does nothing", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([]);
    await connections().disconnect("client-1", "gmail");
    expect(deleted()).toEqual([]);
  });

  test("connecting clears the client's stale tries first and keeps a working account", async () => {
    routes[`GET ${ACCOUNTS}`] = () =>
      accountsBody([
        ["ca_live", "ACTIVE"],
        ["ca_expired", "EXPIRED"],
        ["ca_abandoned", "INITIATED"],
      ]);
    routes[`DELETE ${ACCOUNTS}/ca_expired`] = () => ({ success: true });
    routes[`DELETE ${ACCOUNTS}/ca_abandoned`] = () => ({ success: true });
    routes[`POST ${SESSION}/trs_1/link`] = () => ({
      connected_account_id: "ca_new",
      redirect_url: "https://accounts.google.test/o",
    });
    await connections().connect("client-1", "gmail", "https://locus.test/apps");
    expect(deleted()).toEqual(["ca_expired", "ca_abandoned"]);
    expect(seen.find((s) => s.path === SESSION)?.body).toMatchObject({
      user_id: appUserId("client-1"),
      manage_connections: { enable: false },
      instant: false,
    });
  });
});
