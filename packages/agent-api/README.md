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
