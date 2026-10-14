import { chatKitKey } from "@locus/auth";
import { configured, locus } from "./locus.ts";

type Env = Record<string, string | undefined>;

/**
 * Points the chat kit's proxy (`lib/mastra-proxy.ts`, from the kit's registry) at the agent
 * server's kit routes, and gives it the key it signs requests with. Both come from settings
 * the web app already has. False when the chat isn't set up here.
 */
export function setUpChatKit(env: Env = process.env): boolean {
  const agent = env.LOCUS_AGENT_URL;
  const secret = env.BETTER_AUTH_SECRET;
  if (!agent || !secret) return false;
  env.MASTRA_SERVER_URL = `${agent.replace(/\/+$/, "")}/api/agent/kit`;
  env.MASTRA_JWT_SECRET = chatKitKey(secret);
  return true;
}

/**
 * Who a chat request is for, as the kit's proxy asks it: the signed-in Better Auth session's
 * id, which the agent server loads and checks itself. Null (the proxy answers 401) when nobody
 * is signed in, or when another site's page sent the request with the member's cookie.
 */
export async function chatKitUser(request: Request, env: Env = process.env) {
  const origin = request.headers.get("origin");
  const own = env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).origin : undefined;
  if (origin && origin !== own) return null;
  if (!configured()) return null;
  const current = await locus().auth.api.getSession({ headers: request.headers });
  return current?.session.id ?? null;
}
