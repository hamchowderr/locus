# @locus/agent-api

The HTTP API the chat talks to: Mastra's agent-controller routes for one Locus
`AgentController` per client (`createLocusController` in `@locus/harness`), behind a guard.

```ts
const api = createAgentApi({
  prefix: "/api/agent",
  authorize: async (request) => /* Better Auth session + staff check */ ({ memberId, locationId, clientId }),
  controllerFor: async ({ clientId, locationId }) => /* createLocusController(...), once per client */,
});
// In a route handler: return api.fetch(request);
```

The browser uses `@mastra/client-js`:
`new MastraClient({ baseUrl, apiPrefix: "/api/agent" }).getAgentController("locus").session("client:<locationId>")`.
The resource in the URL must be the signed-in member's own client, or the API answers 403.

What the guard does, and which Mastra routes it leaves out (model switching, session state
such as `yolo`, permission rules, resource rebinding, listing other resources or active
runs), is described at the top of `src/index.ts`. The tests drive it through the real
`MastraClient` against AIMock and the fake GHL.

The controller holds live sessions in memory, and replies arrive on an event stream, so the
host must be a single long-running process, not serverless functions.

## The chat kit's routes

The website's chat is `hamchowderr/mastra-chat-kit`, installed from its registry. Its web proxy
calls the kit's own routes (`/agent-controller/stream`, `/approve`, `/answer`, threads), not
Mastra's, so this API also serves those under `${prefix}/kit/agent-controller/`, behind the
same `authorize` and on the same controller (`src/kit.ts`). Their source in
`src/mastra/routes` and `src/mastra/lib` is the kit's `chat-server` item; update it with
`npx shadcn@4.21.5 add @mastra-chat-kit/chat-server --overwrite` here rather than editing it.

The kit's proxy signs each request with a short-lived token naming the Better Auth session
(`chatKitKey` / `chatKitSessionId` in `@locus/auth`); the host loads that session and runs the
usual checks, exactly as for a cookie. A token still valid for more than ten minutes is refused.
