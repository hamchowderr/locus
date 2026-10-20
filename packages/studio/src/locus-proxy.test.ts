import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCUS_PROXY_CALLS, locusProxyFile, locusSettingsFile } from "./templates/forms.ts";

// Runs the site's generated `/api/locus/[...path]` route for real: written to a temporary folder with
// `next/server` replaced by a stand-in and `@/lib/locus` pointing at the settings Locus writes.

const SITE_API = "https://locus.test/api/sites/site-1";

type Handler = (
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
) => Promise<Response>;

let root: string;
let route: { GET: Handler; POST: Handler };

async function writeRoute(siteApi: string | null) {
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(
    join(root, "next-server.ts"),
    "export const NextResponse = { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) };\n",
  );
  await writeFile(
    join(root, "lib/locus.ts"),
    String(locusSettingsFile(siteApi ? { leadEndpoint: `${siteApi}/leads`, siteApi } : {}).content),
  );
  await writeFile(
    join(root, "route.ts"),
    String(locusProxyFile().content)
      .replace('from "next/server"', 'from "./next-server.ts"')
      .replace('from "@/lib/locus"', 'from "./lib/locus.ts"'),
  );
  route = await import(join(root, "route.ts"));
}

const call = (method: "GET" | "POST", path: string, init: RequestInit = {}, query = "") =>
  route[method](new Request(`https://site.test/api/locus/${path}${query}`, { method, ...init }), {
    params: Promise.resolve({ path: path.split("/") }),
  });

beforeEach(async () => {
  // Outside the source tree, so a run that dies leaves nothing for lint or git to find.
  root = await mkdtemp(join(tmpdir(), "locus-proxy-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("a published site's /api/locus route", () => {
  beforeEach(() => writeRoute(SITE_API));

  it("forwards only the calls Locus lists, server to server, with the visitor's address", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: true }, { status: 200, headers: { "retry-after": "7" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const body = JSON.stringify({ productId: "p1" });
    const response = await call("POST", "checkout", {
      body,
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", cookie: "secret=1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE_API}/checkout`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    // Only these headers: the visitor's cookies never reach Locus.
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-locus-visitor-ip": "203.0.113.7",
    });
  });

  it("keeps the query string on a GET and sends no body", async () => {
    const fetch = vi.fn(async () => Response.json({ days: [] }));
    vi.stubGlobal("fetch", fetch);
    const response = await call("GET", "booking/slots", {}, "?start=2026-10-21&days=7");
    expect(response.status).toBe(200);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE_API}/booking/slots?start=2026-10-21&days=7`);
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ "x-locus-visitor-ip": "" });
  });

  it("answers 404 for anything else, without calling Locus", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const [method, path] of [
      ["GET", "checkout"],
      ["POST", "booking/slots"],
      ["POST", "leads"],
      ["GET", "../internal/sandbox"],
      ["POST", "booking/extra"],
    ] as const) {
      expect(
        (await call(method, path, { ...(method === "POST" ? { body: "{}" } : {}) })).status,
      ).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
    // The list is what the route was written with.
    expect(LOCUS_PROXY_CALLS).toEqual(["GET booking/slots", "POST booking", "POST checkout"]);
  });

  it("refuses a body over 16 KB and a long query before calling Locus", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const big = await call("POST", "booking", { body: "x".repeat(16 * 1024 + 1) });
    expect(big.status).toBe(413);
    const long = await call("GET", "booking/slots", {}, `?q=${"x".repeat(1_000)}`);
    expect(long.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes on only the answer and retry-after, never Locus's other headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true }, { headers: { "set-cookie": "locus=1", "x-internal": "yes" } }),
      ),
    );
    const response = await call("POST", "booking", { body: "{}" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-internal")).toBeNull();
  });

  it("answers a readable error when Locus answers with something that isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 500 })),
    );
    const response = await call("POST", "checkout", { body: "{}" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "That didn't go through." });
  });

  it("says it didn't go through when Locus can't be reached, and passes Locus's errors on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const down = await call("POST", "booking", { body: "{}" });
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: "That didn't go through. Please try again." });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "That time was just taken." }, { status: 409 })),
    );
    const taken = await call("POST", "booking", { body: "{}" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "That time was just taken." });
  });
});

describe("a draft or preview's /api/locus route", () => {
  beforeEach(() => writeRoute(null));

  it("sends nothing anywhere and answers with sample times or a preview", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const slots = await call("GET", "booking/slots", {}, "?start=2026-10-19&days=7&timezone=UTC");
    const sample = (await slots.json()) as { preview: boolean; days: { date: string }[] };
    expect(sample.preview).toBe(true);
    // Weekdays only: Monday 19 to Friday 23 October 2026.
    expect(sample.days.map((d) => d.date)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    const checkout = await call("POST", "checkout", { body: "{}" });
    expect(await checkout.json()).toEqual({ ok: true, preview: true });
    // Still only the listed calls.
    expect((await call("POST", "leads", { body: "{}" })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
