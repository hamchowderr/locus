import { chatKitKey } from "@locus/auth";
import { deploymentBaseUrl } from "./base-url.ts";
import { configured, locus } from "./locus.ts";

type Env = Record<string, string | undefined>;

/** Whether the chat is set up here: the agent server's address and the auth secret are set. */
export function chatKitEnabled(env: Env = process.env): boolean {
  return Boolean(env.LOCUS_AGENT_URL && env.BETTER_AUTH_SECRET);
}

/**
 * Points the chat kit's proxy (`lib/mastra-proxy.ts`, from the kit's registry) at the agent
 * server's kit routes, and gives it the key it signs requests with. Both come from settings
 * the web app already has. False when the chat isn't set up here.
 */
export function setUpChatKit(env: Env = process.env): boolean {
  if (!chatKitEnabled(env)) return false;
  env.MASTRA_SERVER_URL = `${(env.LOCUS_AGENT_URL as string).replace(/\/+$/, "")}/api/agent/kit`;
  env.MASTRA_JWT_SECRET = chatKitKey(env.BETTER_AUTH_SECRET as string);
  return true;
}

type SessionLookup = (headers: Headers) => Promise<{ session: { id: string } } | null>;

const signedIn: SessionLookup = async (headers) =>
  configured() ? locus().auth.api.getSession({ headers }) : null;

/**
 * Who a chat request is for, as the kit's proxy asks it: the signed-in Better Auth session's
 * id, which the agent server loads and checks itself. Null (the proxy answers 401) when nobody
 * is signed in, or when another site's page sent the request with the member's cookie.
 */
export async function chatKitUser(
  request: Request,
  env: Env = process.env,
  session: SessionLookup = signedIn,
) {
  // The same address Better Auth serves this deployment on (a preview's own branch URL).
  const own = new URL(deploymentBaseUrl(env) ?? "http://localhost:3000").origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== own) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return null;
  return (await session(request.headers))?.session.id ?? null;
}
