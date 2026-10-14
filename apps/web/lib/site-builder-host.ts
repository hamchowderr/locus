import type { AuthorizedClient } from "@locus/auth";
import { imagesFromEnv } from "@locus/builder";
import { provisionerFromEnv } from "@locus/db";
import { FakeRuntimeProvider, type RuntimeProvider, sandboxFromEnv } from "@locus/sandbox";
import { configured } from "./connect.ts";
import { publishDeps } from "./hosts.ts";
import { locus, NotConfigured } from "./locus.ts";
import {
  activeSiteIdFor,
  createSiteBuilder,
  openClientDb,
  type SiteBuilderDeps,
  type SiteBuilderWiring,
} from "./site-builder.ts";

const production = process.env.NODE_ENV === "production";

let runtimes: RuntimeProvider | undefined;

/**
 * Site sandboxes on Otaku's Vercel team (`LOCUS_SANDBOX_TOKEN`, `LOCUS_SANDBOX_TEAM_ID`,
 * `LOCUS_SANDBOX_PROJECT_ID`). Without them, local development and tests get the in-memory
 * fake runtime (commands succeed and run nothing, like the other stubs); production refuses.
 */
function siteRuntimes(): RuntimeProvider {
  if (runtimes) return runtimes;
  const vercel = sandboxFromEnv();
  if (vercel) runtimes = vercel;
  else if (production) throw new NotConfigured("LOCUS_SANDBOX_TOKEN, _TEAM_ID or _PROJECT_ID");
  else runtimes = new FakeRuntimeProvider();
  return runtimes;
}

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
  };
}

/**
 * What the chat API host adds to the client's `AgentController` for building sites:
 *
 * ```ts
 * const client = await resolveActiveClient(locus().db, sessionContext(current));
 * const builder = siteBuilderForClient({ client, userId: current.user.id });
 * createLocusController({ ..., modes: builder.modes, tools: builder.tools,
 *   processors: builder.processors });
 * createAgentApi({ requestContext: async (request, member) =>
 *   ({ [SITE_ID_KEY]: await resolveActiveSiteId(request, member) }) });
 * ```
 *
 * `resolve` checks the site against the client again on every tool call. A host that shares
 * one controller between members may also put the request's `AuthorizedClient` under
 * `CLIENT_KEY`; it must be for the same client.
 *
 * `client` must come from `resolveActiveClient` / `authorizeClient` for the signed-in session.
 */
export function siteBuilderForClient(input: {
  client: AuthorizedClient;
  userId?: string | null;
}): SiteBuilderWiring {
  return createSiteBuilder(siteBuilderDeps(), input);
}

/**
 * For the chat API's `requestContext` hook: the site the member chose on the Sites page, only
 * if it belongs to `member.locationId` (the client the host resolved from the session), else
 * null. Never trusts a site id the browser sends in the run itself.
 */
export async function resolveActiveSiteId(
  request: Pick<Request, "headers">,
  member: { locationId: string },
): Promise<string | null> {
  return activeSiteIdFor(locus().db, request, member.locationId);
}

export {
  ACTIVE_SITE_COOKIE,
  CLIENT_KEY,
  SITE_ID_KEY,
  USER_ID_KEY,
} from "./site-builder.ts";
