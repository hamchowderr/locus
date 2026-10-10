/**
 * `GHL_MODE=stub`: a pretend GHL agency, so the connect flow can be built and run without a
 * GoHighLevel account or the Marketplace app. It answers the three OAuth endpoints Locus uses,
 * as the live docs describe them, for one fixture company.
 */

export interface StubAgency {
  companyId: string;
  locations: { _id: string; name: string }[];
}

export const STUB_AGENCY: StubAgency = {
  companyId: "stub-company-1",
  locations: [
    { _id: "stub-location-1", name: "Sunrise Dental" },
    { _id: "stub-location-2", name: "Peak Fitness" },
    { _id: "stub-location-3", name: "Harbor Realty" },
  ],
};

/** The code the stub's authorize page hands back. Any other code is refused, like GHL would. */
export const STUB_CODE = "stub-authorization-code";

/** A `fetch` that plays GHL's OAuth API for one agency. Pages installed locations two at a time. */
export function createStubGhl(agency: StubAgency = STUB_AGENCY): typeof fetch {
  let issued = 0;
  const grant = () => ({
    access_token: `stub-agency-token-${++issued}`,
    token_type: "Bearer",
    expires_in: 86_400,
    refresh_token: `stub-refresh-token-${issued}`,
    scope: "locations.readonly oauth.readonly oauth.write",
    userType: "Company",
    companyId: agency.companyId,
    userId: "stub-user-1",
  });

  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization") ?? "";

    if (method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const ok =
        (form.get("grant_type") === "authorization_code" && form.get("code") === STUB_CODE) ||
        (form.get("grant_type") === "refresh_token" &&
          form.get("refresh_token")?.startsWith("stub-refresh-token-"));
      return ok
        ? Response.json(grant())
        : Response.json({ statusCode: 401, message: "Invalid grant" }, { status: 401 });
    }

    if (!auth.startsWith("Bearer stub-agency-token-")) {
      return Response.json({ statusCode: 401, message: "Invalid token" }, { status: 401 });
    }

    if (method === "GET" && url.pathname === "/oauth/installed-locations") {
      if (url.searchParams.get("companyId") !== agency.companyId) {
        return Response.json({ statusCode: 403, message: "Wrong company" }, { status: 403 });
      }
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const items = agency.locations
        .slice(start, start + 2)
        .map((l) => ({ ...l, address: "", isInstalled: true }));
      const next = start + 2 < agency.locations.length ? String(start + 2) : undefined;
      return Response.json({
        items,
        pagination: {
          hasNextPage: next !== undefined,
          hasPrevPage: start > 0,
          currentPageSize: items.length,
          totalRecords: agency.locations.length,
          ...(next ? { nextPageToken: next } : {}),
        },
      });
    }

    return Response.json(
      { statusCode: 404, message: `stub GHL has no ${method} ${url.pathname}` },
      { status: 404 },
    );
  };
  return stub as typeof fetch;
}
