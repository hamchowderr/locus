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
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const recorded: RecordedRequest = { method, url, headers, body };
    requests.push(recorded);

    const route = routes[`${method} ${url.pathname}`] ?? routes["*"];
    if (!route) {
      return Response.json(
        { statusCode: 404, message: `fake GHL has no route for ${method} ${url.pathname}` },
        { status: 404 },
      );
    }
    const { status = 200, body: payload = {} } =
      typeof route === "function" ? route(recorded) : route;
    return Response.json(payload, { status });
  };

  return { fetch: fakeFetch as typeof fetch, requests };
}
