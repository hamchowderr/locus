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

Every site is a Next.js App Router project (TypeScript, Tailwind CSS, shadcn/ui). Next, React
and Tailwind are on the same versions as `apps/web`; the shadcn packages are the ones its manual
installation names (`cn`, `class-variance-authority`, `lucide-react`, `radix-ui`, and `shadcn`
plus `tw-animate-css` for the CSS), all pinned in `SITE_STACK`. `TEMPLATES` adds starting pages
on top of `baseFiles`: blank, landing page, local business, lead funnel and portfolio.

shadcn/ui is set up as source, the way the CLI would leave it: `components.json`, `lib/utils.ts`
(`cn`), and the components in `SHADCN_COMPONENTS` (accordion, badge, button, card, field, input,
label, separator, sheet, textarea) under `components/ui/`, vendored in `src/templates/shadcn.ts`
from shadcn's new-york style. The header's mobile menu is a Sheet and the lead form is built from
Field parts. Brand colours from the brief become shadcn's CSS variables in `app/globals.css`
(`--primary`, with a readable `--primary-foreground`; the brand accent as `--highlight`), surface
tones are mixed from the background and foreground, and the fonts are `next/font` faces. The builder
adds further components from the shadcn registry (`add_dependency` with a `component`).

## Forms

Every site's forms post to its own `/api/lead` route (`leadRouteFile`, in `baseFiles`), which
forwards the JSON server to server to Locus at `/api/sites/<siteId>/leads`; Locus puts the lead
in the client's GHL sub-account (`submitSiteLead` in `@locus/connect`). The route reads where to
forward from `lib/locus.ts`, which is null in a draft or preview (the route then answers without
sending anything) and is rewritten by `withLocusSettings` on every publish. It holds the site's
public id and Locus's address — no key or token, so nothing secret is ever in a site. The lead
form sends a hidden `fax` honeypot and `elapsedMs` for Locus's spam checks; the `site-forms`
skill in `@locus/builder` tells the agent the contract. An upsert that matches an existing
contact by email or phone updates its name, phone and company (only filling blanks is bead
locus-ptq.18), and a visitor's resend after a lost response can add the note twice. The route
reads at most 16 KB of the body, counted as it arrives.

## Design brief

`DesignBrief` holds the name, kind, goal, audience, tone, layout, pages, palette, fonts and
reference URLs or screenshots. `openQuestions` lists the guided design questions the brief
hasn't answered yet, and `briefForAgent` renders it as plain text for the agent's context.
