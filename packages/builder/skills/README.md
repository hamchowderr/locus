# Site builder skills

Agent Skills (the SKILL.md format) the site builder loads on demand with its `skill` and
`skill_read` tools. Each directory is one skill. `scripts/bundle-skills.ts` bundles every `.md`
file except licences and notices into `src/skills/bundle.generated.ts`; run
`pnpm --filter @locus/builder skills:bundle` after changing a skill (a test fails while the
bundle is out of date).

## Vendored

Copied from their public sources, unchanged except where noted, with their licence files kept
next to them. Update by copying the new release over the directory, re-applying the noted
changes, and updating this table.

| Skill | Source | Version | Licence | Taken | Left out | Changed |
|---|---|---|---|---|---|---|
| `impeccable` | https://github.com/pbakaus/impeccable, `.claude/skills/impeccable` | 4.5.2 (tag `skill-v4.5.2`, commit `d631a8827f99414d2b6daba4ef08b7f8701751d7`) | Apache-2.0 (`LICENSE`, `NOTICE.md` from the repository root) | `SKILL.md`, `reference/**` | `scripts/` (its launcher binary and live-browser scripts, which can't run here) | `reference/overdrive.md` line 53: dropped a product name from the list of motion libraries |
| `shadcn` | https://github.com/shadcn-ui/ui, `skills/shadcn` | shadcn 4.21.5 (tag `shadcn@4.21.5`, commit `0023018feb6e18c2f4aa0af2062f1c3107d90bfa`) | MIT (`LICENSE.md` from the repository root) | `SKILL.md`, the other `*.md`, `rules/*.md` | `assets/`, `scripts/`, `evals/`, `agents/` | none |

Both are written for coding assistants with a shell. The builder's instructions say how they
map onto its tools: no impeccable launcher (it takes the skill's own "launcher unavailable"
path), components through `add_dependency` instead of the shadcn CLI.

## Locus's own

| Skill | Why |
|---|---|
| `site-forms` | Forms on a Locus site post to its own `/api/lead` route, which forwards to Locus and the client's CRM, with the fields and spam checks Locus expects and never a key: a contract no public skill covers. |
