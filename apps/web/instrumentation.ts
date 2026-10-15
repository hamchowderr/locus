// Runs once per server instance, before it serves requests.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { setUpChatKit, chatKitUser } = await import("./lib/chat-kit");
  // Without the agent server, the chat's routes answer 401 rather than reach anything.
  const chat = setUpChatKit();
  const { configureChatKitProxy } = await import("./lib/mastra-proxy");
  configureChatKitProxy({ getUserId: (request) => (chat ? chatKitUser(request) : null) });
  if (process.env.NODE_ENV !== "production") return;
  const { settingsProblems } = await import("./lib/settings-check");
  for (const problem of settingsProblems(process.env)) {
    console.error(`Locus is not configured: ${problem}`);
  }
}
