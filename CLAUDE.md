# Locus — Agent Context

An AI-native system around GoHighLevel: site generation plus cross-client operation for
agencies. The product thinking lives in the Obsidian vault (`hamchowderr/obsidian-vault`):
`1. Projects/Locus/` and the PRD at `2. Areas/Product Manager/PRDs/Locus/Locus.md`. Read the
PRD's "What changed in v0.5" before making design decisions.

**Naming:** Otaku runs Locus · the **agency** is the paying customer (GHL *Company*) · the
**client** is the agency's customer and equals one GHL *location* (UI: "sub-account").

## Git

**Never push to `main`.** Every change goes on a branch and lands through a pull request.

## Rules that are not negotiable

1. **`locationId` comes from the session, never from a request.** No route, tool or agent
   argument may name the client it acts on; the server resolves it and checks the staff
   member's `locationIds` *before* any GHL or Turso token is minted.
2. **The GHL `Version` header is chosen per operation, never globally.** Every operation
   descriptor in `packages/ghl` carries the version its spec requires (usually `v3`; some
   still differ). `@gohighlevel/api-client` sends one global version and is generated from
   old v2 paths — never call it without the wrapper.
3. **The live docs are the API source of truth**, not the `GoHighLevel/highlevel-api-docs`
   repo (stale since 2026-06-19). Use `https://marketplace.gohighlevel.com/docs/llms/v3/llms-full.txt`.
4. **No credential reaches a sandbox or the desktop app.** Generated code and Electron talk to
   the Locus backend; GHL and Turso tokens stay server-side.
5. **GHL is the system of record — never cache GHL data** beyond a single request.
6. **Pin dependencies exactly** (`save-exact=true`). Keep every `better-auth` / `@better-auth/*`
   package on the same version.

## Layout

```
apps/web        Next.js + shadcn/ui — the product and its API
apps/desktop    Electron thin client of apps/web (holds no tokens)
packages/ghl    GHL operation descriptors + the one request path (Version per operation)
packages/testing  AIMock wiring + a fake GHL for tests
packages/skills   one folder per GHL API category: SKILL.md, manifest, fixtures, evals
packages/harness  Mastra loop, query_data, perform_action, subagents
packages/db     Drizzle schema (control DB + per-client DB) and migrations
packages/ui     shared shadcn components for web and desktop
```

## Commands

```
pnpm install
pnpm check        # Biome lint + format check
pnpm typecheck
pnpm test         # Vitest; AIMock replaces the model, a fake replaces GHL
```

## Testing

AIMock-first: every agent, tool and skill ships with a deterministic test. Three levels per
skill — (1) plumbing: AIMock + fake GHL, every CI run; (2) selection evals: real model, gated
and token-budgeted; (3) live smoke against the GHL test sub-account, manual. AIMock decides
what the "model" does, so it cannot test skill *choice* — that is level 2's job.

GHL Workflows (the product feature) and Mastra Workflows (our orchestration) are different
things — always say which.
