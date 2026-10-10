# Git and pull requests

- **Never push to `main`.** Every change goes on a branch and lands through a pull request.
- Claude's branches are named `claude/<short-topic>`. Open PRs as drafts.
- Before pushing, run what CI runs: `pnpm check`, `pnpm --filter @locus/skills generate:check`,
  `pnpm typecheck`, `pnpm test`, `pnpm build`. Push only when all pass.
- Keep a PR to one purpose. A refactor found along the way is its own PR.
- Commit the docs snapshot and the regenerated catalog in the same commit.
- Never commit secrets or `.env` files. Secrets live in Infisical (`/locus`), and the GitHub App
  private key is never an environment variable.
