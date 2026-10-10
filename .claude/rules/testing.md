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
3. **Live smoke** — the GHL test sub-account. Manual.

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
