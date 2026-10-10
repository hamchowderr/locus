# Locus

AI-native system around GoHighLevel: site generation and cross-client operation for agencies.

Product docs live in the Obsidian vault — start with the PRD's "What changed in v0.5". Agent
and contributor rules: [`CLAUDE.md`](CLAUDE.md).

```
pnpm install
pnpm check && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @locus/web dev        # http://localhost:3000
pnpm --filter @locus/desktop dev    # Electron, loads LOCUS_URL (default localhost:3000)
```

Requires Node 22.12+ and pnpm 10.
