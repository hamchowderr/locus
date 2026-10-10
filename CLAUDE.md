# Locus — Agent Context

An AI-native system around GoHighLevel: site generation plus cross-client operation for
agencies. The product thinking lives in the Obsidian vault (`hamchowderr/obsidian-vault`):
`1. Projects/Locus/` and the PRD at `2. Areas/Product Manager/PRDs/Locus/Locus.md`. Read the
PRD's "What changed in v0.5" before making design decisions.

**Naming:** Otaku runs Locus · the **agency** is the paying customer (GHL *Company*) · the
**client** is the agency's customer and equals one GHL *location* (UI: "sub-account").

## Rules

Detailed rules live in `.claude/rules/`; the path-scoped ones load when you touch matching
files. The short version:

- **Never push to `main`** — branch, then pull request. (`git.md`)
- **`locationId` comes from the session, never from a request**, and staff restrictions run
  before any token is minted. (`tenancy.md`)
- **GHL's live docs export is the API source of truth**, the skill catalog is generated from it,
  and every GHL call goes through `ghlRequest` with a per-operation `Version`. (`ghl-api.md`)
- **No credential reaches a sandbox or the desktop app.** (`tenancy.md`, `desktop.md`)
- **Pin dependencies exactly.** (`dependencies.md`)
- **AIMock-first tests**, three levels per skill. (`testing.md`)

## Layout

```
apps/web          Next.js + shadcn/ui — the product and its API
apps/desktop      Electron thin client of apps/web (holds no tokens)
packages/ghl      operation descriptors + the one GHL request path
packages/testing  AIMock wiring + a fake GHL for tests
packages/skills   the GHL skill catalog, generated from the docs (see its README)
packages/harness  Mastra loop, query_data, perform_action, subagents
packages/db       Drizzle schema (control DB + per-client DB) and migrations
packages/ui       shared shadcn components for web and desktop
```

## Commands

```
pnpm install
pnpm check                                   # Biome lint + format
pnpm --filter @locus/skills generate:check   # catalog matches the docs snapshot
pnpm typecheck
pnpm test                                    # Vitest; AIMock replaces the model, a fake replaces GHL
pnpm build
```
