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
- **Never write Mastra code from memory** — use the `mastra` skill and MCP server, and never
  send feedback to Mastra without asking. (`mastra.md`)

## Layout

```
apps/web          Next.js + shadcn/ui — the product and its API
apps/desktop      Electron thin client of apps/web (holds no tokens)
apps/agent        the agent server: the chat's API for every client, one long-running process
packages/auth     Better Auth: accounts, agencies, staff access, billing, operators
packages/connect  GHL, GitHub and Vercel connections, sites and domains
packages/secrets  where agencies' credentials are sealed
packages/ghl      operation descriptors + the one GHL request path
packages/testing  AIMock wiring + a fake GHL for tests
packages/skills   the GHL skill catalog, generated from the docs (see its README)
packages/harness  Mastra loop, query_data, perform_action, subagents
packages/agent-api the chat's HTTP API: guarded agent-controller routes per client
packages/sandbox  the isolated runtime where Site Studio builds and previews a site
packages/db       Drizzle schema (control DB + per-client DB) and migrations
packages/studio   generated sites' source, versions, design brief and templates
packages/builder  the site-builder agent: its tools, instructions and AgentController mode
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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
