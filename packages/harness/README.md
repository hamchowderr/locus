# @locus/harness

The agent: one Mastra loop, three tools, nothing GHL-specific in the system prompt. Design:
vault note `Locus Agent Layer` (Factorial's "Don't program an LLM with English").

```ts
const agent = createLocusAgent({ model, session });   // one per request
await agent.generate("Which clients had no new leads this week?");
```

`session` is resolved server-side from the signed-in user. Every tool closes over it, so the
model can never point a call at another client.

## The tools

| Tool | Does | Enforced in code |
|---|---|---|
| `load_skill` | Returns a GHL area's `SKILL.md` and operation index | Unknown areas are refused |
| `query_data` | Reads: sources → tables → one SQL `SELECT` → only the result | Reads only · pages every source to the end · carries IDs between sources (`forEach`) · refuses paging params it owns · fails loudly on non-composable chains, too many requests or too wide a fan-out · flags sources it could not page fully (`complete: false`) |
| `perform_action` | One write operation | Writes only · deletions need approval (Mastra `requireApproval`) |

Mistakes the model can fix (an unknown operation, a bad chain, a GHL 4xx) come back as
`{ error }` so it can correct itself; anything else throws.

`query_data` uses an in-memory libSQL database per call, created and thrown away. Nested
objects are stored as JSON text — query them with `json_extract`.

## Not here yet

- A shared GHL rate-limit budget across agents (100 req / 10 s per location).
- Cursor pagination (`after`, `cursor`, `startAfter`) — reported as incomplete for now.
- Subagents per task or per client.
- The prompt-injection processor on tool results.
- Site Studio's workspace tools.
