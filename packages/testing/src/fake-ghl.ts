/**
 * A fake of the GHL HTTP API for level-1 (plumbing) tests: a `fetch` replacement that answers
 * from a route table and records every request so tests can assert on exactly what was sent.
 */

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Keyed by `"METHOD /path"`, matched against the request path with no query string. The key `"*"`
 * answers any request no other route matches.
 */
export type FakeRoutes = Record<string, FakeResponse | ((req: RecordedRequest) => FakeResponse)>;

export interface FakeGhl {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

export function createFakeGhl(routes: FakeRoutes): FakeGhl {
  const requests: RecordedRequest[] = [];

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const form = headers["content-type"]?.startsWith("application/x-www-form-urlencoded");
    // Form bodies (GHL's OAuth endpoints) are recorded as a plain object of their fields.
    const body =
      raw === undefined
        ? undefined
        : form
          ? Object.fromEntries(new URLSearchParams(raw))
          : JSON.parse(raw);
    const recorded: RecordedRequest = { method, url, headers, body };
    requests.push(recorded);

    const route = routes[`${method} ${url.pathname}`] ?? routes["*"];
    if (!route) {
      return Response.json(
        { statusCode: 404, message: `fake GHL has no route for ${method} ${url.pathname}` },
        { status: 404 },
      );
    }
    const {
      status = 200,
      body: payload = {},
      headers: responseHeaders,
    } = typeof route === "function" ? route(recorded) : route;
    return Response.json(payload, {
      status,
      ...(responseHeaders ? { headers: responseHeaders } : {}),
    });
  };

  return { fetch: fakeFetch as typeof fetch, requests };
}
