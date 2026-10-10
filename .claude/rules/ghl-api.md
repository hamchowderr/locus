---
paths:
  - "packages/ghl/**"
  - "packages/skills/**"
  - "packages/harness/**"
  - "apps/web/**/api/**"
---

# Working with the GoHighLevel API

## Where the truth is

- **GHL's live docs export is the only API source:**
  `https://marketplace.gohighlevel.com/docs/llms/v3/llms-full.txt` (index: `.../llms/v3/llms.txt`,
  one compact file per service: `.../llms/v3/<service>.md`). GHL generates it from their OpenAPI
  specs at build time.
- **Do not use the `GoHighLevel/highlevel-api-docs` GitHub repo.** It stopped updating on
  2026-06-19 and is ~100 endpoints behind the live docs.
- **Do not trust model memory or blog posts** for paths, fields or versions. Look it up in
  `packages/skills/catalog/<service>/reference.md`, which is the export verbatim.
- Search bodies (`POST /contacts/search` and similar) are documented as free-form objects; the
  real filter syntax is only in the ClickUp doc GHL links from the description.

## The catalog is generated — never hand-edit it

- `packages/skills/catalog/*/manifest.ts`, `operations.md`, `reference.md`,
  `packages/skills/src/generated/**` and `packages/skills/source/**` are produced by
  `packages/skills/scripts/`. Fix the generator or the parser, then regenerate.
- Refresh: `pnpm --filter @locus/skills docs:fetch && pnpm --filter @locus/skills generate`,
  then commit snapshot and output together. CI's `generate:check` fails if they disagree.
- `catalog/<service>/SKILL.md` is the exception: seeded once, then hand-written. The generator
  never overwrites it.
- A docs defect (undocumented path parameter etc.) goes to `source/docs-defects.md`
  automatically; don't work around one silently elsewhere.

## Calling GHL

- **Every call goes through `ghlRequest` in `@locus/ghl`** with an operation descriptor from the
  catalog. Never call `@gohighlevel/api-client` directly: it sends one global `Version` and is
  generated from old v2 paths.
- The `Version` header comes from the operation, never from config. Today every v3 operation is
  `v3`; GHL already points some deprecated ones at `v4`.
- `locationId`, `altId`/`altType` and `companyId` are filled from the session by
  `ghlRequest`. Never pass them as input — it throws. See the tenancy rule.
- Only JSON bodies are sent so far; multipart and form operations throw until implemented.
- Errors arrive as `{statusCode, message}` or, on a few endpoints, AIP-style `{error: {...}}`;
  both become `GhlError`.
- Rate limits: 100 requests / 10 s and 200k / day, per app per location. One shared budget
  across every agent — never a per-call retry loop.

## Things GHL cannot do through its API

- **GHL workflows cannot be created or edited** — only listed, and contacts enrolled/removed.
  Provisioning uses snapshots (`snapshotId` on location create). The internal
  `backend.leadconnectorhq.com` API needs a browser session token: never use it.
- Social account OAuth links need a human in a browser.
- "GHL Workflows" (the product) and "Mastra workflows" (our orchestration) are different things —
  always say which.
