import { type GhlOperation, type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { ConnectError } from "./errors.ts";

/** The Locus GHL Marketplace app. Client id and secret come from Infisical `/locus`. */
export interface GhlAppConfig {
  clientId: string;
  clientSecret: string;
  /** The Marketplace app's id, which `installed-locations` filters on. */
  appId: string;
  redirectUri: string;
  scopes: readonly string[];
  /**
   * Where the agency is sent to approve the app. The neutral host, never the GoHighLevel-branded
   * one: a white-labelled agency must not see "GoHighLevel", and we can't know which agencies are
   * white-labelled until after they install.
   */
  authorizeBase?: string;
}

export interface GhlHttp {
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** What Locus keeps of an agency's grant — in the secret store, never in the database. */
export interface AgencyGrant {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string;
  companyId: string;
  /** The GHL user who approved the install. Provenance only — it is never an access check. */
  installedBy: string;
}

export const NEUTRAL_AUTHORIZE_BASE = "https://marketplace.leadconnectorhq.com";

/** The page an agency owner opens to approve Locus on their GHL company. */
export function authorizeUrl(config: GhlAppConfig, state: string): string {
  const url = new URL("/oauth/chooselocation", config.authorizeBase ?? NEUTRAL_AUTHORIZE_BASE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

function operation(id: string): GhlOperation {
  const op = operationById(id);
  if (!op) throw new Error(`The skill catalog is missing ${id}`);
  return op;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  userType?: string;
  companyId?: string;
  userId?: string;
}

/** The token endpoint takes no Authorization header, so no real session is involved. */
const NO_SESSION: GhlSession = { token: "", tokenKind: "agency" };

/**
 * GHL's install page lists the agency first and its sub-accounts below. Picking a single
 * sub-account installs Locus there alone and yields a Location token, which can't list or reach
 * the agency's other sub-accounts; picking the agency is the bulk install, which yields the
 * Company token Locus runs on and then asks which sub-accounts get Locus.
 */
function toGrant(res: TokenResponse, now: number): AgencyGrant {
  if (res.userType !== "Company" || !res.companyId) {
    throw new ConnectError(
      "You picked a single sub-account. Connect again and pick your agency at the top of " +
        "GoHighLevel's list; it then asks which sub-accounts get Locus.",
    );
  }
  if (!res.access_token || !res.refresh_token || !res.expires_in) {
    throw new ConnectError("GoHighLevel's sign-in response was incomplete. Try connecting again.");
  }
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: now + res.expires_in * 1000,
    scopes: res.scope ?? "",
    companyId: res.companyId,
    installedBy: res.userId ?? "",
  };
}

/** Swaps the authorization code from the redirect for an agency (Company) grant. */
export async function exchangeCode(
  config: GhlAppConfig,
  code: string,
  http: GhlHttp = {},
  now = Date.now(),
): Promise<AgencyGrant> {
  const res = await ghlRequest<TokenResponse>(
    operation("oauth.get-access-token"),
    NO_SESSION,
    {
      body: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        user_type: "Company",
        redirect_uri: config.redirectUri,
      },
    },
    http,
  );
  return toGrant(res, now);
}

/** Agency tokens last a day; this renews one with its refresh token. */
export async function refreshGrant(
  config: GhlAppConfig,
  grant: AgencyGrant,
  http: GhlHttp = {},
  now = Date.now(),
): Promise<AgencyGrant> {
  const res = await ghlRequest<TokenResponse>(
    operation("oauth.get-access-token"),
    NO_SESSION,
    {
      body: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
        user_type: "Company",
        redirect_uri: config.redirectUri,
      },
    },
    http,
  );
  const renewed = toGrant(res, now);
  if (renewed.companyId !== grant.companyId) {
    throw new Error("GoHighLevel refreshed the token for a different company.");
  }
  return { ...renewed, installedBy: grant.installedBy };
}

interface LocationTokenResponse {
  access_token?: string;
  locationId?: string;
}

/**
 * Exchanges the agency token for one sub-account's token. The caller has already run the
 * staff check; this only talks to GHL. The sub-account and agency come from the session, which
 * `ghlRequest` puts in the form body — never from the caller's input.
 */
export async function mintLocationToken(
  agency: { token: string; companyId: string },
  ghlLocationId: string,
  http: GhlHttp = {},
): Promise<string> {
  const session: GhlSession = {
    token: agency.token,
    tokenKind: "agency",
    companyId: agency.companyId,
    locationId: ghlLocationId,
  };
  const res = await ghlRequest<LocationTokenResponse>(
    operation("oauth.get-location-access-token"),
    session,
    {},
    http,
  );
  if (!res.access_token) throw new Error("GoHighLevel's sub-account token response was empty.");
  if (res.locationId && res.locationId !== ghlLocationId) {
    throw new Error("GoHighLevel returned a token for a different sub-account.");
  }
  return res.access_token;
}

/** The sub-account's name as GHL has it, read with that sub-account's own session. */
export async function readLocationName(session: GhlSession, http: GhlHttp = {}): Promise<string> {
  const res = await ghlRequest<{ location?: { name?: string } }>(
    operation("locations.get-location"),
    session,
    {},
    http,
  );
  return res.location?.name ?? "";
}

export interface InstalledLocation {
  ghlLocationId: string;
  name: string;
}

interface InstalledLocationsPage {
  items?: { _id: string; name: string; isInstalled?: boolean }[];
  pagination?: { hasNextPage?: boolean; nextPageToken?: string };
}

/** Every sub-account the agency has installed Locus on, all pages. */
export async function listInstalledLocations(
  config: GhlAppConfig,
  agency: { token: string; companyId: string },
  http: GhlHttp = {},
): Promise<InstalledLocation[]> {
  const session: GhlSession = {
    token: agency.token,
    tokenKind: "agency",
    companyId: agency.companyId,
  };
  const found: InstalledLocation[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const res = await ghlRequest<InstalledLocationsPage>(
      operation("oauth.get-installed-location"),
      session,
      { query: { appId: config.appId, isInstalled: true, pageSize: 100, pageToken } },
      http,
    );
    for (const item of res.items ?? []) {
      if (item.isInstalled !== false) found.push({ ghlLocationId: item._id, name: item.name });
    }
    if (!res.pagination?.hasNextPage || !res.pagination.nextPageToken) return found;
    pageToken = res.pagination.nextPageToken;
  }
  throw new Error("GoHighLevel kept returning pages of installed locations; stopped at 1000.");
}
