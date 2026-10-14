# @locus/studio

A generated site's source, kept in its client's own database: the working tree the agent edits,
numbered versions saved from it, the design brief, and the templates a site starts from.

```ts
const ws = new SiteWorkspace(tenantDb, siteId);       // tenantDb: that client's database only
await startSite(ws, { brief: { name: "Bright Smiles", goal: "Book a cleaning" } });
await ws.writeFile("app/page.tsx", source);
await ws.saveVersion({ message: "New hero", source: "agent", userId });
await ws.restoreVersion(versionId);                    // saved as a new version: undoable
```

The caller resolves the client from the session, checks the site belongs to it in the control
database, and opens only that client's database. Nothing here takes a client id.

## Storage

| Table | Holds |
|---|---|
| `site_blob` | Each distinct file content once, by SHA-256 (binary files base64) |
| `site_draft_file` | The working tree: path → blob, per site |
| `site_version` / `site_version_file` | Saved versions, numbered per site, and their files |
| `site_brief` | The design brief, validated by `DesignBrief` |
| `generation_run` | One agent turn that changed a site |

`saveVersion` saves nothing when the draft equals the latest version. `restoreVersion` makes an
old version the draft and saves it as a new version, so history only grows. Versions can be
bookmarked and carry the commit they were pushed as.

## Rules enforced in code

`normalizeSitePath` refuses absolute paths, `..`, `.git/`, `node_modules/`, `.next/` and any
`.env` file: generated code goes to the agency's repository and runs in a sandbox, so it never
carries a secret. Files are capped at 4 MB and sites at 2,000 files.

## Templates

Every site is a Next.js App Router project (TypeScript, Tailwind CSS) on the same versions as
`apps/web` (`SITE_STACK`). `TEMPLATES` adds starting pages on top of `baseFiles`: blank, landing
page, local business, lead funnel and portfolio. Brand colours and fonts from the brief become
Tailwind theme tokens and `next/font` faces. Forms post to the site's own `/api/lead` route,
which Locus connects to the client's CRM.

## Design brief

`DesignBrief` holds the name, kind, goal, audience, tone, layout, pages, palette, fonts and
reference URLs or screenshots. `openQuestions` lists the guided design questions the brief
hasn't answered yet, and `briefForAgent` renders it as plain text for the agent's context.
