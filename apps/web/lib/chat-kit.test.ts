import { chatKitKey } from "@locus/auth";
import { describe, expect, it } from "vitest";
import { chatKitUser, setUpChatKit } from "./chat-kit";

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
});
