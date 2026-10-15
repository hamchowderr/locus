import { chatKitKey, chatKitSessionId } from "@locus/auth";
import { describe, expect, it } from "vitest";
import { chatKitUser, setUpChatKit } from "./chat-kit";
import { signServerToken } from "./mastra-proxy";

describe("the chat kit's settings", () => {
  it("come from the agent address and the auth secret", () => {
    const env: Record<string, string | undefined> = {
      LOCUS_AGENT_URL: "https://agent.example/",
      BETTER_AUTH_SECRET: "s3cret",
    };
    expect(setUpChatKit(env)).toBe(true);
    expect(env.MASTRA_SERVER_URL).toBe("https://agent.example/api/agent/kit");
    expect(env.MASTRA_JWT_SECRET).toBe(chatKitKey("s3cret"));
  });

  it("are left alone when the chat isn't set up", () => {
    const env: Record<string, string | undefined> = { BETTER_AUTH_SECRET: "s3cret" };
    expect(setUpChatKit(env)).toBe(false);
    expect(env.MASTRA_JWT_SECRET).toBeUndefined();
  });

  it("refuse a request another site's page sent", async () => {
    const request = new Request("https://locus.example/api/agent-controller/stream", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(await chatKitUser(request, { BETTER_AUTH_URL: "https://locus.example" })).toBeNull();
  });

  const signedIn = async () => ({ session: { id: "sess-1" } });
  const post = (origin: string | null, site?: string) =>
    new Request("https://locus.example/api/agent-controller/stream", {
      method: "POST",
      headers: { ...(origin ? { origin } : {}), ...(site ? { "sec-fetch-site": site } : {}) },
    });

  it("name the signed-in session for the site's own pages", async () => {
    const env = { BETTER_AUTH_URL: "https://locus.example" };
    expect(await chatKitUser(post("https://locus.example", "same-origin"), env, signedIn)).toBe(
      "sess-1",
    );
    expect(await chatKitUser(post(null), env, signedIn)).toBe("sess-1");
    expect(await chatKitUser(post(null, "cross-site"), env, signedIn)).toBeNull();
    expect(await chatKitUser(post(null), env, async () => null)).toBeNull();
  });

  it("take a preview's own address as the site's, as sign-in does", async () => {
    const env = {
      BETTER_AUTH_URL: "https://staging.example",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "locus-git-x.vercel.app",
    };
    expect(await chatKitUser(post("https://locus-git-x.vercel.app"), env, signedIn)).toBe("sess-1");
    expect(await chatKitUser(post("https://staging.example"), env, signedIn)).toBeNull();
    expect(await chatKitUser(post("http://localhost:3000"), {}, signedIn)).toBe("sess-1");
  });

  it("sign tokens the agent server accepts", () => {
    const env: Record<string, string | undefined> = {
      LOCUS_AGENT_URL: "https://agent.example",
      BETTER_AUTH_SECRET: "s3cret",
    };
    setUpChatKit(env);
    const token = signServerToken(env.MASTRA_JWT_SECRET as string, "sess-1");
    expect(chatKitSessionId(token, chatKitKey("s3cret"))).toBe("sess-1");
  });
});
