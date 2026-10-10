---
paths:
  - "**/*.test.ts"
  - "packages/testing/**"
  - "packages/skills/**"
  - "packages/harness/**"
---

# Testing

AIMock-first: every agent, tool and skill ships with a deterministic test.

## Three levels per skill

1. **Plumbing** — AIMock plays the model, `createFakeGhl` plays GHL. Proves the code turns a
   model decision into the right GHL request. Runs on every CI run. No network, no real model.
2. **Selection evals** — a real model; proves the harness picks the right skills and actions for
   a prompt. Gated and token-budgeted, not in CI.
3. **Live smoke** — a real GHL sub-account. Manual, never in CI:
   `LOCUS_LIVE=1 pnpm --filter @locus/harness test:live` with `GHL_API_KEY` (a Private
   Integration Token) and `GHL_LOCATION_ID` set; add `NODE_USE_ENV_PROXY=1` in a proxied cloud
   session. Today's account is a **real client's production account** (KnowBS): read-only, assert
   against GHL's own totals rather than fixed numbers, never print or commit its data. Writes
   wait for the test-mode ledger and the trigger review in the vault note
   `KnowBS/GHL Account Inventory`.

AIMock decides what the "model" does, so it can never test skill *choice* — that is level 2.

## How

- `useAimock()` from `@locus/testing` starts the mock around a suite. Fixtures match on the
  user message (and turn, tool result, etc.) and can return `toolCalls`.
- `createFakeGhl(routes)` replaces `fetch` for `ghlRequest`; assert on `fake.requests`
  (method, URL, headers, body). `"*"` is a catch-all route.
- Prefer real operation descriptors from `@locus/skills`' catalog over hand-written ones.
- Prefer recorded GHL responses where GHL's docs are wrong or blank; record from the test
  sub-account, strip personal data, and commit them next to the skill.
- Never skip, disable or quarantine a test to get green, and never weaken an assertion to
  match broken behaviour. Fix the cause.
