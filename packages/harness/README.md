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

## Conversations and approvals

Pass the client's conversation store (a `LibSQLStore` over that client's own Turso database)
as `storage` and the agent keeps message history per thread and parks changes that need
approval as run snapshots, so a person can approve them in a later request:

```ts
const agent = createLocusAgent({ model, session, storage });
await agent.generate(text, { memory: { thread: threadId, resource: clientResource(session) } });

// later, in another request
const later = createLocusAgent({ model, session, storage });
await pendingApprovals(later, session, threadId);
await decideApproval(later, session, { threadId, toolCallId, approve: true });
```

The resource is always `clientResource(session)`, so a thread, and anything pending in it, can
only be read or decided for the client that owns it. GHL data is not cached between requests:
`ForgetGhlData` replaces each tool result with a stub (keeping errors and `rowCount`) before
memory saves the run, and the next turn reads GHL again. History is budgeted by tokens
(`HISTORY_TOKENS`); titles and semantic recall are off because each would cost a model call.
A paused run resumes from its snapshot, which keeps the taint marks, so a tainted run stays
tainted after an approval; the stubs in memory drop them, so a later turn starts clean.

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

## The chat kit's controller

`createLocusController` hosts the Locus agent in a Mastra `AgentController`, which is what
Mastra's chat kit talks to. There is one controller per client, over that client's own
database, and every session on it belongs to that client (`openClientSession`); a member only
picks their own session. The host checks staff restrictions before opening one, and its
`session` function returns a token for that client only (anything else is refused before a
request is sent).

- **Act** (default) reads and changes data with the usual approval rules. **Ask** offers only
  reads. Other features add their own modes and tools.
- Each tool decides whether a call waits for approval; the controller then asks the person.
  "Always allow" approves only that call. Never set a session's `yolo` state or grant tools.
- Planning and subagent built-ins are off: the GHL agent has no workspace.

## Not here yet

- A rate-limit budget shared across serverless instances (today it is per process).
- Cursor pagination (`after`, `cursor`, `startAfter`) — reported as incomplete for now.
- Subagents per task or per client.
- The agent API routes in `apps/web` that serve the controller to the chat kit.
- Site Studio's workspace tools.
