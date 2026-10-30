/**
 * `GHL_MODE=stub`: a pretend GHL agency, so the connect flow can be built and run without a
 * GoHighLevel account or the Marketplace app. It answers the OAuth endpoints Locus uses, as the
 * live docs describe them, for one fixture company — plus users search for its staff, reading a
 * sub-account with that sub-account's own token, listing its conversations (two made-up ones),
 * and taking a site's lead (contact upsert, tags, note) without keeping it.
 */

export interface StubAgency {
  companyId: string;
  /** The agency's name, as GHL's company endpoint returns it. */
  name?: string;
  locations: { _id: string; name: string }[];
  /** Agency staff, as GHL's users search returns them. */
  users: {
    id: string;
    name: string;
    email: string;
    roles: { type: string; role: string; locationIds: string[]; restrictSubAccount: boolean };
  }[];
}

export const STUB_AGENCY: StubAgency = {
  companyId: "stub-company-1",
  name: "Stub Agency",
  locations: [
    { _id: "stub-location-1", name: "Sunrise Dental" },
    { _id: "stub-location-2", name: "Peak Fitness" },
    { _id: "stub-location-3", name: "Harbor Realty" },
  ],
  // Invite these addresses in Locus, then "Import client access from GoHighLevel".
  users: [
    {
      id: "stub-user-1",
      name: "Avery Admin",
      email: "avery@stub-agency.test",
      roles: { type: "agency", role: "admin", locationIds: [], restrictSubAccount: false },
    },
    {
      id: "stub-user-2",
      name: "Sam Restricted",
      email: "sam@stub-agency.test",
      roles: {
        type: "agency",
        role: "user",
        locationIds: ["stub-location-1", "stub-location-3"],
        restrictSubAccount: true,
      },
    },
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

    // A sub-account token reaches its own sub-account and nothing else.
    const asLocation = /^Bearer stub-location-token-(.+)-\d+$/.exec(auth)?.[1];
    if (asLocation) {
      const own = agency.locations.find((l) => l._id === asLocation);
      if (method === "GET" && own && url.pathname === `/locations/${own._id}`) {
        return Response.json({ location: { id: own._id, name: own.name } });
      }
      // The chat's Inbox (`listInbox`): two made-up conversations, for this sub-account only.
      if (own && method === "GET" && url.pathname === "/conversations/search") {
        if (url.searchParams.get("locationId") !== own._id) {
          return Response.json(
            { statusCode: 403, message: "Not this sub-account" },
            { status: 403 },
          );
        }
        const at = Date.parse("2026-10-14T12:00:00Z");
        return Response.json({
          conversations: [
            {
              id: `stubconv1${own._id.replace(/\W/g, "")}`,
              contactId: "stubcontact1",
              locationId: own._id,
              fullName: "Jordan Visitor",
              lastMessageBody: "Hi, is the open house still on Sunday?",
              lastMessageType: "TYPE_LIVE_CHAT",
              lastMessageDate: at,
              unreadCount: 1,
            },
            {
              id: `stubconv2${own._id.replace(/\W/g, "")}`,
              contactId: "stubcontact2",
              locationId: own._id,
              contactName: "Riley Buyer",
              lastMessageBody: "Thanks, see you then.",
              lastMessageType: "TYPE_SMS",
              lastMessageDate: at - 3_600_000,
              unreadCount: 0,
            },
          ],
          total: 2,
        });
      }
      // A site's lead form (`submitSiteLead`): accepted and forgotten, nothing is kept.
      if (own && method === "POST" && url.pathname === "/contacts/upsert") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { locationId?: string };
        if (body.locationId !== own._id) {
          return Response.json(
            { statusCode: 403, message: "Not this sub-account" },
            { status: 403 },
          );
        }
        return Response.json({ new: true, contact: { id: `stub-contact-${++issued}` } });
      }
      if (own && method === "PUT" && /^\/contacts\/stub-contact-\d+$/.test(url.pathname)) {
        return Response.json({ succeeded: true, contact: { id: url.pathname.split("/")[2] } });
      }
      if (own && method === "POST" && /^\/contacts\/stub-contact-\d+\/tags$/.test(url.pathname)) {
        return Response.json({ tags: [] }, { status: 201 });
      }
      if (own && method === "POST" && /^\/contacts\/stub-contact-\d+\/notes$/.test(url.pathname)) {
        return Response.json({ note: { id: `stub-note-${++issued}` } }, { status: 201 });
      }
      return Response.json({ statusCode: 403, message: "Not this sub-account" }, { status: 403 });
    }

    if (!auth.startsWith("Bearer stub-agency-token-")) {
      return Response.json({ statusCode: 401, message: "Invalid token" }, { status: 401 });
    }

    if (method === "GET" && url.pathname === `/companies/${agency.companyId}`) {
      return Response.json({ company: { id: agency.companyId, name: agency.name ?? "" } });
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

    if (method === "POST" && url.pathname === "/oauth/location-token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const locationId = form.get("locationId");
      const installed = agency.locations.some((l) => l._id === locationId);
      if (form.get("companyId") !== agency.companyId || !installed) {
        return Response.json({ statusCode: 400, message: "Not installed" }, { status: 400 });
      }
      return Response.json({
        access_token: `stub-location-token-${locationId}-${++issued}`,
        token_type: "Bearer",
        expires_in: 86_400,
        scope: "locations.readonly",
        locationId,
        userId: "stub-user-1",
      });
    }

    if (method === "GET" && url.pathname === "/users/search") {
      if (url.searchParams.get("companyId") !== agency.companyId) {
        return Response.json({ statusCode: 403, message: "Wrong company" }, { status: 403 });
      }
      const type = url.searchParams.get("type");
      const matching = agency.users.filter((u) => !type || u.roles.type === type);
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      return Response.json({ users: matching.slice(skip, skip + limit), count: matching.length });
    }

    return Response.json(
      { statusCode: 404, message: `stub GHL has no ${method} ${url.pathname}` },
      { status: 404 },
    );
  };
  return stub as typeof fetch;
}
