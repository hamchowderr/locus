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

## GoHighLevel data is untrusted

Form submissions, messages and notes are written by the public, so a tool result can carry
text aimed at the agent. `UntrustedContentProcessor` screens every GHL-derived result (Mastra
`processToolResult`) before the model or memory sees it: strings and keys that read like
instructions are replaced with a `withheld` marker. A run that hit one, or that read free text
the public writes (submissions, messages, notes, reviews, comments) whether or not a pattern
matched, is *tainted*, and from then on every `perform_action` waits for a person's approval.
The taint is marked in the run's own tool results and re-derived before each model step
(`processInputStep`), so it survives a run resumed in a later request. The patterns catch common
phrasings, not all of them: for public free text the approval gate covers what they miss. No
model is involved, so this costs nothing per call.

## Rate limit

Every request goes through the client's burst budget in `@locus/ghl` (`sharedRateLimiter`, 90
per 10 s per location, under GHL's 100). Callers wait for a slot instead of failing. A 429
pauses that client's whole budget for as long as GHL asks; the request that got it fails as a
normal `{ error }` and is not retried in a loop. The budget is per process.

## Test-write mode

The only way to write to a real client's account while testing. Pass a guard to the tools or
to `performAction`:

```ts
const writeGuard = createTestWriteGuard({ run: "rb-2026-10-10", ledger: fileLedger(path) });
createLocusTools({ session, writeGuard });
```

Enforced in code: an allow-list of contact / note / task / tag / opportunity operations; new
contacts must be `Locus Test …` with an `@example.com` email and no phone; only `locus-test-*`
tags; updates and deletes only on records this run created; every created record goes into the
ledger. `cleanupRun` (or `scripts/cleanup-test-run.ts <run> --delete`) removes them, newest
first, and is safe to repeat.

## Not here yet

- A rate-limit budget shared across serverless instances (today it is per process).
- Cursor pagination (`after`, `cursor`, `startAfter`) — reported as incomplete for now.
- Subagents per task or per client.
- Site Studio's workspace tools.
