---
paths:
  - "**/package.json"
  - "pnpm-workspace.yaml"
  - "pnpm-lock.yaml"
---

# Dependencies

- **Pin exactly** — `.npmrc` has `save-exact=true`; never add a caret or tilde by hand.
- **Check the current version on npm before adding a package** (`npm view <pkg> version`); do
  not trust a remembered version.
- Keep every `better-auth` and `@better-auth/*` package on the same exact version. Use the
  `auth` CLI (`npx auth@latest generate`), not `@better-auth/cli`, which is stale.
- `electron-vite` 5 supports Vite 5–7 only; `apps/desktop` stays on Vite 7 until it moves.
- pnpm only runs install scripts for packages listed under `onlyBuiltDependencies` in
  `pnpm-workspace.yaml`. Add one only when the package genuinely needs it.
- Workspace packages are consumed as TypeScript source (`exports` points at `src/index.ts`);
  there is no build step for them.
- Run `pnpm install` from the repo root and commit `pnpm-lock.yaml` with the change.
