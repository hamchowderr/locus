# @locus/skills

One skill per GHL API service (44 today), generated from GHL's live docs export and then
deepened by hand.

```
source/
  v3-llms-full.txt     snapshot of https://marketplace.gohighlevel.com/docs/llms/v3/llms-full.txt
  meta.json            when it was fetched, and its sha256
  docs-defects.md      problems found in GHL's docs while generating (generated)
catalog/<service>/
  SKILL.md             hand-written guidance — created once as a stub, then owned by people
  manifest.ts          every operation: path, Version, token kinds, scopes, session params (generated)
  operations.md        one-line index of the operations (generated)
  reference.md         the service's section of GHL's docs, verbatim (generated)
src/
  docs/parse.ts        the export parser — fails loudly on anything it does not recognise
  generated/catalog.ts every manifest, plus the snapshot's provenance (generated)
```

## Refreshing from GHL

```
pnpm --filter @locus/skills docs:fetch      # new snapshot (only rewrites if the content changed)
pnpm --filter @locus/skills generate        # rewrite generated files, seed missing SKILL.md
pnpm --filter @locus/skills test            # parser tests + plumbing test for every operation
```

Commit the snapshot and the generated files together. CI runs `generate:check` and fails when
they disagree. In a proxied environment (Claude cloud sessions) `docs:fetch` needs
`NODE_USE_ENV_PROXY=1`.

## Tests

`catalog.test.ts` sends every operation through `@locus/ghl`'s request path against a fake GHL
and checks the method, path, `Version` header, auth header and where the session's
`locationId` / `companyId` land — the level-1 plumbing test for the whole API surface.
Selection evals (level 2) and fixtures per skill come next.
