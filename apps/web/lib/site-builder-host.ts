import { type AuthorizedClient, authorizeClient, ClientAccessDenied } from "@locus/auth";
import { imagesFromEnv } from "@locus/builder";
import { provisionerFromEnv } from "@locus/db";
import type { RuntimeProvider } from "@locus/sandbox";
import { configured } from "./connect.ts";
import { publishDeps } from "./hosts.ts";
import { billingEnabled, locus, configured as locusConfigured, sessionContext } from "./locus.ts";
import {
  activeSiteIdFor,
  createSiteBuilder,
  openClientDb,
  runtimesFromEnv,
  type SiteBuilderDeps,
  type SiteBuilderWiring,
} from "./site-builder.ts";

let runtimes: RuntimeProvider | undefined;
const siteRuntimes = () => {
  runtimes ??= runtimesFromEnv();
  return runtimes;
};

let images: ReturnType<typeof imagesFromEnv> | undefined;

/** Everything the site builder needs, from the deployment's environment. Server-side only. */
export function siteBuilderDeps(): SiteBuilderDeps {
  const { db } = locus();
  const provisioner = configured(() => provisionerFromEnv(".data/tenants"));
  images ??= imagesFromEnv();
  return {
    db,
    openClientDb: (client) => openClientDb(provisioner, client),
    runtimes: siteRuntimes,
    images,
    publish: publishDeps,
    billing: billingEnabled(),
  };
}

/**
 * What the chat API host adds to the client's `AgentController` for building sites:
 *
 * ```ts
 * const client = await resolveActiveClient(locus().db, sessionContext(current));
 * const builder = siteBuilderForClient({ client });
 * createLocusController({ ..., modes: builder.modes, tools: builder.tools,
 *   processors: builder.processors });
 * createAgentApi({ requestContext: async (request, member) =>
 *   ({ [SITE_ID_KEY]: await resolveActiveSiteId(request, member) }) });
 * ```
 *
 * On every tool call `resolve` runs the staff check again and checks the site against the
 * client. The host's hook sets `SITE_ID_KEY`, overwriting anything the browser sent.
 * `CLIENT_KEY` works only where the request context keeps live objects in process; a context
 * that is serialized (such as `@locus/agent-api`'s) loses the `AuthorizedClient`, so build one
 * controller per client there and leave `CLIENT_KEY` unset.
 *
 * `client` must come from `resolveActiveClient` / `authorizeClient` for the signed-in session.
 */
export function siteBuilderForClient(input: { client: AuthorizedClient }): SiteBuilderWiring {
  return createSiteBuilder(siteBuilderDeps(), input);
}

/**
 * For the chat API's `requestContext` hook: the site the member chose on the Sites page, or
 * null. The member's access to `member.locationId` is checked again from the request's own
 * session cookie, and the site must be one of that client's; a site id sent by the browser in
 * the run itself is never read.
 */
export async function resolveActiveSiteId(
  request: Pick<Request, "headers">,
  member: { locationId: string },
): Promise<string | null> {
  if (!locusConfigured()) return null;
  const { db, auth } = locus();
  const current = await auth.api.getSession({ headers: new Headers(request.headers) });
  if (!current) return null;
  try {
    const client = await authorizeClient(db, sessionContext(current), member.locationId);
    return await activeSiteIdFor(db, request, client);
  } catch (error) {
    if (error instanceof ClientAccessDenied) return null;
    throw error;
  }
}

export { ACTIVE_SITE_COOKIE, CLIENT_KEY, closeClientDbs, SITE_ID_KEY } from "./site-builder.ts";
