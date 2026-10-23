import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AppServiceError } from "./apps.ts";
import {
  appUserId,
  CATALOG_TTL_MS,
  createComposioCatalog,
  createComposioConnections,
  createComposioConnector,
  parseAuthConfigs,
} from "./composio.ts";

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
let routes: Record<
  string,
  (body: Record<string, unknown> | undefined, query: URLSearchParams) => unknown
> = {};

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
    const revoke = /^\/api\/v3\.1\/connected_accounts\/([^/]+)\/revoke$/.exec(path);
    // Revoking succeeds unless a test says otherwise, as it does at Composio.
    const route =
      routes[`${req.method} ${path}`] ??
      (req.method === "POST" && revoke
        ? () => ({
            revoked_tokens: ["access_token"],
            connected_account: { id: revoke[1], status: "REVOKED" },
          })
        : undefined);
    res.setHeader("content-type", "application/json");
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
      return;
    }
    const answer = route(body, url.searchParams) as { status?: number } | undefined;
    // A route answers with an error status by returning `{ status, error }`.
    if (typeof answer?.status === "number") res.statusCode = answer.status;
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const SESSION = "/api/v3.1/tool_router/session";
const TOOLKITS = "/api/v3.1/toolkits";
const ACCOUNTS = "/api/v3.1/connected_accounts";

/** A toolkit as Composio lists it; `managed` is the sign-ins Composio runs itself. */
const toolkitItem = (
  slug: string,
  { managed = ["OAUTH2"], noAuth = false }: { managed?: string[]; noAuth?: boolean } = {},
) => ({
  slug,
  name: slug[0]?.toUpperCase() + slug.slice(1),
  type: "native",
  is_local_toolkit: false,
  no_auth: noAuth,
  auth_schemes: noAuth ? [] : ["OAUTH2"],
  composio_managed_auth_schemes: managed,
  deprecated: { toolkitId: slug },
  meta: {
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    description: `${slug} for teams`,
    logo: `https://logos.test/${slug}.png`,
    categories: [{ id: "communication", name: "Communication" }],
    triggers_count: 0,
    tools_count: 3,
    version: "1",
  },
});
const catalogBody = (items: unknown[], next: string | null = null) => ({
  items,
  next_cursor: next,
  total_pages: next ? 2 : 1,
  current_page: 1,
  total_items: items.length,
});
/**
 * Composio's catalog: three apps whose sign-in Composio manages, one it doesn't (GitHub here,
 * standing for any app that needs Otaku's own OAuth app) and one with no sign-in at all.
 */
const CATALOG = [
  toolkitItem("gmail"),
  toolkitItem("slack"),
  toolkitItem("googlecalendar"),
  toolkitItem("github", { managed: [] }),
  toolkitItem("codeinterpreter", { managed: [], noAuth: true }),
];

beforeEach(() => {
  seen = [];
  routes = {
    [`POST ${SESSION}`]: () => ({
      session_id: "trs_1",
      mcp: { type: "http", url: `${baseURL}/mcp/trs_1` },
      tool_router_tools: [],
      config: { user_id: "locus-client:client-1" },
    }),
    [`GET ${TOOLKITS}`]: () => catalogBody(CATALOG),
  };
});

/** A fresh catalog per test, so one test's cache can't answer another's. */
const catalog = (now?: () => number) =>
  createComposioCatalog({ apiKey: "test-key", baseURL, ...(now ? { now } : {}) });
const catalogReads = () => seen.filter((s) => s.path === TOOLKITS);

/** A search answer as Composio sends it. */
const searchBody = () => ({
  success: true,
  error: null,
  results: [
    {
      index: 0,
      use_case: "read my email",
      primary_tool_slugs: ["GMAIL_FETCH_EMAILS", "SLACK_LIST_MESSAGES"],
      related_tool_slugs: ["GMAIL_GET_PROFILE", "GITHUB_LIST_ISSUES"],
      toolkits: ["gmail", "slack", "github"],
    },
  ],
  tool_schemas: {
    GMAIL_FETCH_EMAILS: {
      tool_slug: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      description: "Fetch emails",
      input_schema: { type: "object", properties: { max_results: { type: "integer" } } },
    },
    SLACK_LIST_MESSAGES: {
      tool_slug: "SLACK_LIST_MESSAGES",
      toolkit: "slack",
      description: "List messages",
      input_schema: { type: "object", properties: {} },
    },
    GITHUB_LIST_ISSUES: {
      tool_slug: "GITHUB_LIST_ISSUES",
      toolkit: "github",
      description: "List issues",
      input_schema: { type: "object", properties: {} },
    },
  },
  toolkit_connection_statuses: [
    { toolkit: "gmail", description: "Gmail", has_active_connection: true, status_message: "" },
    { toolkit: "slack", description: "Slack", has_active_connection: false, status_message: "" },
    // Connected somehow, but not an app Locus offers: neither its tools nor its name come back.
    { toolkit: "github", description: "GitHub", has_active_connection: true, status_message: "" },
    { toolkit: "notion", description: "Notion", has_active_connection: false, status_message: "" },
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
const toolBody = (slug: string, tags: string[], toolkit = slug.split("_")[0]?.toLowerCase()) => ({
  slug,
  name: slug,
  description: "",
  tags,
  toolkit: { slug: toolkit, name: "", logo: "" },
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
  createComposioConnector({
    apiKey: "test-key",
    clientId: "client-1",
    baseURL,
    catalog: catalog(),
  });

describe("Composio catalog", () => {
  test("offers Composio's apps whose sign-in Composio manages, and only those", async () => {
    const apps = await catalog().apps();
    expect(apps.map((app) => app.toolkit)).toEqual(["gmail", "slack", "googlecalendar"]);
    expect(apps[0]).toEqual({
      toolkit: "gmail",
      name: "Gmail",
      description: "gmail for teams",
      logo: "https://logos.test/gmail.png",
      categories: [{ id: "communication", name: "Communication" }],
    });
    const [read] = catalogReads();
    expect(read?.query.get("type")).toBe("native");
    expect(read?.query.get("include_deprecated")).toBe("false");
    expect(read?.query.get("limit")).toBe("1000");
  });

  test("reads every page of the catalog", async () => {
    routes[`GET ${TOOLKITS}`] = (_, query) =>
      query.get("cursor") === "page-2"
        ? catalogBody([toolkitItem("notion"), toolkitItem("gmail")])
        : catalogBody([toolkitItem("gmail"), toolkitItem("slack")], "page-2");
    const apps = await catalog().apps();
    expect(apps.map((app) => app.toolkit)).toEqual(["gmail", "slack", "notion"]);
    expect(catalogReads().map((r) => r.query.get("cursor"))).toEqual([null, "page-2"]);
  });

  test("says which apps it offers, by slug in any case", async () => {
    const offered = catalog();
    expect(await offered.offers("GMAIL")).toBe(true);
    expect(await offered.offers("github")).toBe(false);
    expect(await offered.offers("codeinterpreter")).toBe(false);
    expect(await offered.offers("notion")).toBe(false);
  });

  test("is read once and kept for a while, then read again", async () => {
    let now = 1_000;
    const offered = catalog(() => now);
    await Promise.all([offered.apps(), offered.offers("gmail"), offered.apps()]);
    now += CATALOG_TTL_MS - 1;
    await offered.offers("slack");
    expect(catalogReads()).toHaveLength(1);
    now += 1;
    await offered.apps();
    expect(catalogReads()).toHaveLength(2);
  });

  test("a failed read isn't kept: the next call reads again", async () => {
    routes[`GET ${TOOLKITS}`] = () => ({ error: { message: "down" } });
    const offered = catalog();
    await expect(offered.apps()).rejects.toThrow();
    routes[`GET ${TOOLKITS}`] = () => catalogBody(CATALOG);
    expect(await offered.offers("gmail")).toBe(true);
  });

  test("while a refresh fails, the last catalog read is still served", async () => {
    let now = 1_000;
    const offered = catalog(() => now);
    const before = await offered.apps();
    routes[`GET ${TOOLKITS}`] = () => ({ error: { message: "down" } });
    now += CATALOG_TTL_MS;
    expect(await offered.apps()).toEqual(before);
    expect(await offered.offers("gmail")).toBe(true);
    // The failure itself isn't kept: once Composio is back, the next call reads afresh.
    routes[`GET ${TOOLKITS}`] = () => catalogBody(CATALOG);
    await offered.apps();
    expect(catalogReads()).toHaveLength(4);
  });
});

describe("Composio connector", () => {
  test("opens one session for the client, with no sign-in links and no Instant accounts", async () => {
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
      manage_connections: { enable: false },
      // Never a Composio-owned account, which Composio bills for.
      instant: false,
      // Composio's code sandbox stays off (sent under its old name).
      workbench: { enable: false },
    });
    expect(seen.filter((s) => s.path.endsWith("/execute")).map((s) => s.body)).toEqual([
      expect.objectContaining({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }),
      expect.objectContaining({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }),
    ]);
  });

  test("an app with Otaku's own sign-in app uses the accounts connected through it", async () => {
    routes[`POST ${SESSION}/trs_1/execute`] = () => ({
      data: {},
      error: null,
      log_id: "log_1",
      result_type: "completed",
    });
    const apps = createComposioConnector({
      apiKey: "test-key",
      clientId: "client-1",
      baseURL,
      catalog: catalog(),
      authConfigs: { gmail: "ac_own" },
    });
    await apps.execute("GMAIL_FETCH_EMAILS", {});
    expect(seen.find((s) => s.path === SESSION)?.body).toMatchObject({
      auth_configs: { gmail: "ac_own" },
    });
  });

  test("search lists the connected apps' tools, and offered apps that aren't connected", async () => {
    routes[`POST ${SESSION}/trs_1/search`] = (body) => {
      expect(body).toMatchObject({ queries: [{ use_case: "read my email" }] });
      return searchBody();
    };

    const found = await connector().search("read my email");

    // GMAIL_GET_PROFILE came without a schema, so the model couldn't call it right; Slack's tool
    // waits for Slack to be connected; GitHub and Notion aren't apps Locus offers.
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

  test("a tool is offered by its own toolkit in Composio's metadata, not by its name", async () => {
    routes["GET /api/v3.1/tools/GMAIL_FETCH_EMAILS"] = () =>
      toolBody("GMAIL_FETCH_EMAILS", ["readOnlyHint"]);
    routes["GET /api/v3.1/tools/GITHUB_LIST_ISSUES"] = () =>
      toolBody("GITHUB_LIST_ISSUES", ["readOnlyHint"]);
    routes["GET /api/v3.1/tools/GMAIL_SNEAKY"] = () =>
      toolBody("GMAIL_SNEAKY", ["readOnlyHint"], "github");
    const apps = connector();

    expect(await apps.offers("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(await apps.offers("GITHUB_LIST_ISSUES")).toBe(false);
    expect(await apps.offers("GMAIL_SNEAKY")).toBe(false);
    // A tool from an app Locus doesn't offer never counts as read-only either.
    expect(await apps.readOnly("GMAIL_SNEAKY")).toBe(false);
    expect(await apps.readOnly("GITHUB_LIST_ISSUES")).toBe(false);
  });

  test("a tool's app comes from its own metadata, and only for apps Locus offers", async () => {
    routes["GET /api/v3.1/tools/GMAIL_FETCH_EMAILS"] = () =>
      toolBody("GMAIL_FETCH_EMAILS", ["readOnlyHint"], "GMAIL");
    routes["GET /api/v3.1/tools/SLACK_SNEAKY"] = () => toolBody("SLACK_SNEAKY", [], "github");
    const apps = connector();

    expect(await apps.toolkit("GMAIL_FETCH_EMAILS")).toBe("gmail");
    expect(await apps.toolkit("SLACK_SNEAKY")).toBeNull();
  });

  test("a tool deletes when Composio tags it destructive or its name says so", async () => {
    const tags: Record<string, string[]> = {
      GMAIL_SEND_EMAIL: ["openWorldHint"],
      GMAIL_FETCH_EMAILS: ["readOnlyHint"],
      GMAIL_DELETE_MESSAGE: [],
      GMAIL_MOVE_TO_TRASH: [],
      GMAIL_EMPTY_FOLDER: ["destructiveHint"],
      GMAIL_REMOVED_LABELS_LIST: ["readOnlyHint"],
      GOOGLESHEETS_CLEAR_VALUES: [],
      NOTION_ARCHIVE_NOTION_PAGE: [],
      SLACK_ARCHIVE_CONVERSATION: [],
      GOOGLECALENDAR_CANCEL_EVENT: [],
      GITHUB_REVOKE_TOKEN: [],
      GOOGLEDRIVE_EMPTY_TRASH: [],
      SUPABASE_DROP_TABLE: [],
      SUPABASE_TRUNCATE_TABLE: [],
      SLACK_UNINSTALL_APP: [],
      GMAIL_DISCARD_DRAFTS: [],
    };
    for (const [slug, t] of Object.entries(tags)) {
      routes[`GET /api/v3.1/tools/${slug}`] = () => toolBody(slug, t);
    }
    routes["GET /api/v3.1/tools/GITHUB_LIST_ISSUES"] = () =>
      toolBody("GITHUB_LIST_ISSUES", ["readOnlyHint"]);
    const apps = connector();

    expect(await apps.deletes("GMAIL_SEND_EMAIL")).toBe(false);
    expect(await apps.deletes("GMAIL_FETCH_EMAILS")).toBe(false);
    expect(await apps.deletes("GMAIL_REMOVED_LABELS_LIST")).toBe(false);
    expect(await apps.deletes("GMAIL_DELETE_MESSAGE")).toBe(true);
    expect(await apps.deletes("GMAIL_MOVE_TO_TRASH")).toBe(true);
    expect(await apps.deletes("GMAIL_EMPTY_FOLDER")).toBe(true);
    // Untagged tools that clear, archive, cancel or revoke count as deletes too.
    for (const slug of [
      "GOOGLESHEETS_CLEAR_VALUES",
      "NOTION_ARCHIVE_NOTION_PAGE",
      "SLACK_ARCHIVE_CONVERSATION",
      "GOOGLECALENDAR_CANCEL_EVENT",
      "GITHUB_REVOKE_TOKEN",
      "GOOGLEDRIVE_EMPTY_TRASH",
      "SUPABASE_DROP_TABLE",
      "SUPABASE_TRUNCATE_TABLE",
      "SLACK_UNINSTALL_APP",
      "GMAIL_DISCARD_DRAFTS",
    ]) {
      expect(await apps.deletes(slug), slug).toBe(true);
    }
    // A tool from an app Locus doesn't offer is never vouched for.
    expect(await apps.deletes("GITHUB_LIST_ISSUES")).toBe(true);
  });

  test("a tool Composio doesn't know isn't offered: the lookup fails as a service error", async () => {
    await expect(connector().offers("NOPE_TOOL")).rejects.toThrow(AppServiceError);
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
    routes[`POST ${SESSION}`] = (body, query) => {
      if (fail) {
        fail = false;
        return { error: { message: "down" } };
      }
      return open?.(body, query);
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
});

describe("Composio connections", () => {
  const connections = () =>
    createComposioConnections({ apiKey: "test-key", baseURL, catalog: catalog() });

  /** The client's accounts as Composio lists them, `next` naming a further page. */
  const accountsBody = (
    accounts: [id: string, status: string, toolkit?: string, authConfig?: string][],
    next: string | null = null,
  ) => ({
    items: accounts.map(([id, status, toolkit = "gmail", authConfig = "ac_1"]) => ({
      id,
      status,
      status_reason: null,
      is_disabled: false,
      created_at: "2026-10-20T00:00:00Z",
      updated_at: "2026-10-20T00:00:00Z",
      toolkit: { slug: toolkit },
      auth_config: {
        id: authConfig,
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
  /** Every account change in order, as `revoke ca_x` and `delete ca_x`. */
  const changes = () =>
    seen.flatMap((s) => {
      const id = s.path.slice(ACCOUNTS.length + 1).replace(/\/revoke$/, "");
      if (s.method === "DELETE") return [`delete ${id}`];
      if (s.method === "POST" && s.path.endsWith("/revoke")) return [`revoke ${id}`];
      return [];
    });

  test("lists every app Locus offers for the client, with the ones it connected", async () => {
    routes[`GET ${ACCOUNTS}`] = () =>
      accountsBody([
        ["ca_gmail", "ACTIVE", "gmail"],
        ["ca_slack", "EXPIRED", "slack"],
        // Connected before the app left Locus's catalog: still listed, so it can be removed.
        ["ca_old", "ACTIVE", "oldapp"],
      ]);
    const listed = await connections().list("client-1");
    expect(listed.map((app) => [app.toolkit, app.connected])).toEqual([
      ["gmail", true],
      ["slack", false],
      ["googlecalendar", false],
      ["oldapp", true],
    ]);
    expect(listed[0]).toMatchObject({ name: "Gmail", logo: "https://logos.test/gmail.png" });
    // Slack's sign-in expired: shown as needing a reconnect, the others not.
    expect(listed.filter((app) => app.expired).map((app) => app.toolkit)).toEqual(["slack"]);
    const [list] = seen.filter((s) => s.path === ACCOUNTS);
    expect(list?.query.getAll("user_ids").join(",")).toBe(appUserId("client-1"));
  });

  test("a revoked sign-in needs a reconnect too, unless another sign-in still works", async () => {
    routes[`GET ${ACCOUNTS}`] = () =>
      accountsBody([
        ["ca_slack", "REVOKED", "slack"],
        ["ca_gmail_old", "EXPIRED", "gmail"],
        ["ca_gmail", "ACTIVE", "gmail"],
      ]);
    const listed = await connections().list("client-1");
    expect(listed.filter((app) => app.expired).map((app) => app.toolkit)).toEqual(["slack"]);
    expect(listed.find((app) => app.toolkit === "gmail")).toMatchObject({ connected: true });
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
    expect(seen.find((s) => s.path === SESSION)?.body).toMatchObject({
      user_id: appUserId("client-1"),
      toolkits: { enable: ["gmail"] },
      manage_connections: { enable: false },
      instant: false,
    });
  });

  describe("with Otaku's own sign-in app for Gmail", () => {
    const own = () =>
      createComposioConnections({
        apiKey: "test-key",
        baseURL,
        catalog: catalog(),
        authConfigs: { gmail: "ac_own" },
      });

    test("a Gmail connected through Composio's sign-in needs connecting again", async () => {
      routes[`GET ${ACCOUNTS}`] = () =>
        accountsBody([
          ["ca_gmail_old", "ACTIVE", "gmail", "ac_1"],
          ["ca_slack", "ACTIVE", "slack", "ac_2"],
        ]);
      const listed = await own().list("client-1");
      expect(listed.find((app) => app.toolkit === "gmail")).toMatchObject({
        connected: false,
        expired: true,
      });
      // Apps without Otaku's own sign-in app are as before.
      expect(listed.find((app) => app.toolkit === "slack")).toMatchObject({ connected: true });
      expect(listed.find((app) => app.toolkit === "slack")?.expired).toBeUndefined();

      routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_gmail", "ACTIVE", "gmail", "ac_own"]]);
      const again = await own().list("client-1");
      expect(again.find((app) => app.toolkit === "gmail")).toMatchObject({ connected: true });
    });

    test("connecting signs in through it, after removing the old sign-in", async () => {
      routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_gmail_old", "ACTIVE", "gmail", "ac_1"]]);
      routes[`DELETE ${ACCOUNTS}/ca_gmail_old`] = () => ({ success: true });
      routes[`POST ${SESSION}/trs_1/link`] = () => ({
        connected_account_id: "ca_new",
        redirect_url: "https://accounts.google.test/o",
      });
      await own().connect("client-1", "gmail", "https://locus.test/apps");
      expect(changes()).toEqual(["revoke ca_gmail_old", "delete ca_gmail_old"]);
      expect(seen.find((s) => s.path === SESSION)?.body).toMatchObject({
        auth_configs: { gmail: "ac_own" },
      });
    });
  });

  test("only apps Locus offers can be connected", async () => {
    for (const toolkit of ["github", "codeinterpreter", "notion"]) {
      await expect(connections().connect("client-1", toolkit, "https://x")).rejects.toThrow(
        AppServiceError,
      );
    }
    // Only the catalog was read: no account, session or sign-in reached Composio.
    expect(seen.filter((s) => s.path !== TOOLKITS)).toEqual([]);
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

  test("a client that goes loses every app it connected, in any state", async () => {
    routes[`GET ${ACCOUNTS}`] = () =>
      accountsBody([
        ["ca_gmail", "ACTIVE"],
        ["ca_slack", "EXPIRED", "slack"],
      ]);
    routes[`DELETE ${ACCOUNTS}/ca_gmail`] = () => ({ success: true });
    routes[`DELETE ${ACCOUNTS}/ca_slack`] = () => ({ success: true });
    await connections().disconnectAll("client-1");
    const [list] = seen.filter((s) => s.path === ACCOUNTS);
    expect(list?.query.getAll("user_ids").join(",")).toContain(appUserId("client-1"));
    expect(list?.query.getAll("toolkit_slugs")).toEqual([]);
    expect(deleted()).toEqual(["ca_gmail", "ca_slack"]);
  });

  test("an app that left the catalog can still be disconnected; a strange name can't", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_old", "ACTIVE", "oldapp"]]);
    routes[`DELETE ${ACCOUNTS}/ca_old`] = () => ({ success: true });
    await connections().disconnect("client-1", "oldapp");
    expect(deleted()).toEqual(["ca_old"]);
    seen = [];
    await expect(connections().disconnect("client-1", "a&b")).rejects.toThrow(AppServiceError);
    expect(seen).toEqual([]);
  });

  test("disconnecting revokes the app's access before deleting the account", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_gmail", "ACTIVE"]]);
    routes[`DELETE ${ACCOUNTS}/ca_gmail`] = () => ({ success: true });
    await connections().disconnect("client-1", "gmail");
    expect(changes()).toEqual(["revoke ca_gmail", "delete ca_gmail"]);
  });

  test("an app that can't be revoked from outside, or a half-finished sign-in, is only deleted", async () => {
    routes[`GET ${ACCOUNTS}`] = () =>
      accountsBody([
        ["ca_gmail", "ACTIVE"],
        ["ca_tried", "INITIATED"],
      ]);
    routes[`POST ${ACCOUNTS}/ca_gmail/revoke`] = () => ({
      status: 400,
      error: { message: "not supported" },
    });
    routes[`DELETE ${ACCOUNTS}/ca_gmail`] = () => ({ success: true });
    routes[`DELETE ${ACCOUNTS}/ca_tried`] = () => ({ success: true });
    await connections().disconnect("client-1", "gmail");
    // Only a working account is revoked: Composio refuses the others.
    expect(changes()).toEqual(["revoke ca_gmail", "delete ca_gmail", "delete ca_tried"]);
  });

  test("a revoke Composio couldn't do keeps the account, so a retry revokes it", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_gmail", "ACTIVE"]]);
    routes[`POST ${ACCOUNTS}/ca_gmail/revoke`] = () => ({
      status: 500,
      error: { message: "provider down" },
    });
    await expect(connections().disconnect("client-1", "gmail")).rejects.toThrow();
    expect(deleted()).toEqual([]);
  });

  test("a client that goes is removed even while an app can't be revoked", async () => {
    routes[`GET ${ACCOUNTS}`] = () => accountsBody([["ca_gmail", "ACTIVE"]]);
    routes[`POST ${ACCOUNTS}/ca_gmail/revoke`] = () => ({
      status: 500,
      error: { message: "provider down" },
    });
    routes[`DELETE ${ACCOUNTS}/ca_gmail`] = () => ({ success: true });
    await connections().disconnectAll("client-1");
    expect(deleted()).toEqual(["ca_gmail"]);
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
  });
});

describe("parseAuthConfigs", () => {
  test("reads toolkit=auth config pairs", () => {
    expect(parseAuthConfigs("gmail=ac_1, GoogleCalendar = ac_2,")).toEqual({
      gmail: "ac_1",
      googlecalendar: "ac_2",
    });
    expect(parseAuthConfigs(undefined)).toEqual({});
    expect(parseAuthConfigs(" ")).toEqual({});
  });

  test("refuses anything else, rather than signing in the wrong way", () => {
    for (const text of ["gmail", "gmail=", "gmail=123", "=ac_1", "g mail=ac_1", "gmail=ac_1=x"]) {
      expect(() => parseAuthConfigs(text)).toThrow(/COMPOSIO_AUTH_CONFIGS/);
    }
  });
});
