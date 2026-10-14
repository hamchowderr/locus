# @locus/builder

The site builder: the tools and instructions an agent uses to build and change a client's
Next.js site. It plugs into the shared Mastra `AgentController` as a mode, or runs as its own
agent.

```ts
// AgentController: the mode names the tools, the tools go in the controller's `tools`, and
// the processor goes in its `processors` (a mode can't carry processors in @mastra/core 1.75).
createLocusController({
  modes: [SITE_BUILDER_MODE],
  tools: createSiteBuilderTools({ resolve }),
  processors: [new UntrustedOutputProcessor()],
  ownTextTools: SITE_BUILDER_OWN_TEXT_TOOLS, // the skill tools: past the GHL screen, kept
});

const agent = createSiteBuilderAgent({ model, resolve }); // standalone (subagent, tests)
```

`SITE_BUILDER_MODE` is a plain `AgentControllerMode` whose `availableTools` lists
`SITE_BUILDER_TOOL_NAMES`. Every tool sets `requireApproval` to a function returning `false`:
none of them needs a person's approval, and the controller otherwise asks for every tool that
doesn't decide for itself (only a function overrides its global setting, a boolean doesn't).

`resolve(requestContext)` is the host's: from the signed-in session it finds the client, checks
the site belongs to that client, opens that client's database and the site's sandbox, and
returns a `BuilderSession`. Every tool call goes through it, so nothing the model says can
point a tool at another site or client. The session's optional `release()` runs once the call
has finished (succeeded or failed), e.g. to return a pooled database connection.

## Tools

Eleven tools (there were seventeen; related ones are actions of one tool now, with every check
still in the tool):

| Tool | Does |
|---|---|
| `skill` / `skill_read` | Loads a skill, reads a file it links to (below) |
| `brief` | The design brief and the design questions still open; `changes` records decisions |
| `files` | `list` `read` `write` `edit` `delete` on the site's draft, in its client's database (`@locus/studio`) |
| `run_command` | One command in the site's sandbox, after syncing the draft; refuses package changes |
| `add_dependency` | An npm `package` at its exact current version, or a shadcn/ui `component` from a registry (below) |
| `check_site` | Install + `next build`; returns ok or the errors to fix |
| `preview` | The live preview URL; with `logs`, only the dev server's output |
| `fetch_reference` | Reads a reference site's outline, fetched inside the sandbox |
| `generate_image` | An original PNG into `public/`, from `ImageGenerator` |
| `versions` | `save` `list` `restore`; a save calls `onVersionSaved` (e.g. commit to the agency's GitHub) |

## Skills

The instructions stay short and static (they are cached) and list each skill's name and
description; the agent loads what a task needs. The skills are Agent Skills (SKILL.md) in
`skills/`: `impeccable` (frontend design) and `shadcn` vendored from their public sources with
their licences (versions and sources in `skills/README.md`), and Locus's own `site-forms`.
`scripts/bundle-skills.ts` bundles them into `src/skills/bundle.generated.ts`, and Mastra's own
skills support serves them (`createSkill`, `resolveAgentSkills`), so nothing is read from disk
at run time. An unknown skill or file comes back as `{ error }` listing what there is.

`skill` and `skill_read` behave like Mastra's tools of the same names but are the builder's
own: given to an agent's `skills`, Mastra's tools decide nothing about approval, so inside an
AgentController each skill load would wait for a person, and @mastra/core 1.75 resumes an
approved run without the mode's `availableTools`. `createSiteBuilderAgent` uses the same tools.

## Components from a registry

`add_dependency({ component })` adds a shadcn/ui component without the shadcn CLI: an official
name (`dialog`) is read from `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, the style
the site's vendored components use; another shadcn-compatible registry's item is given by its
https URL. Items are fetched inside the sandbox, never by Locus's servers. Their files are
written into the draft (by `target` or type, as the CLI lays out a project, with
`@/registry/...` imports rewritten to the site's aliases) through the workspace's path checks;
the components they depend on come too (at most twelve items), a component the site already has
is kept unless `overwrite`, and their npm packages are pinned exactly and installed in one go.
CSS variables an item wants and its docs are returned for the agent to apply, screened as
outside text.

Mistakes the model can fix (a refused path, a failed build, no credits left) come back as
`{ error }`. Sandbox work and images are checked against the client's credits first
(`UsageMeter.check`) and recorded after (`UsageMeter.record`); the host meters LLM tokens.

## The draft is the source of truth

The site's files live in the client's database (the draft); the sandbox is a copy that every
sandbox tool brings up to date first (`syncRuntime`). Sync keeps no memory of what a sandbox
holds: it asks the sandbox each time (one `find … -exec sha256sum`), writes what differs and
deletes what the draft no longer has. So a sandbox the provider recreated empty behind the same
runtime, one another process synced, or one a command changed, is always put right.

Sync never deletes what the sandbox makes for itself — lockfiles (`pnpm-lock.yaml`,
`package-lock.json`, `yarn.lock`), `next-env.d.ts` and `*.tsbuildinfo` — and never looks
inside `node_modules/`, `.next/`, `.git/` or `.locus/` (the sandbox's own markers, which the
workspace refuses as a path).

Packages change only through `add_dependency` (or `files` write/edit on
`package.json`), so what `check_site` builds is what `versions` save saves and publishes.
`run_command` refuses `npm install <pkg>`, `pnpm add`, `uninstall` and the like, and if a
command changes the sandbox's `package.json` anyway (through a shell, say) it is put back to
the draft's straight after, with a note telling the model to use `add_dependency`.

## Outside text is data

Reference pages, command output, build output and dev-server logs can carry text planted to
steer the agent. `UntrustedOutputProcessor` screens those tools' results on Mastra's
`processToolResult`, with no model: sentences or lines that read like instructions to an AI are
withheld, chat-template markers are defanged, and the rest is fenced as data
(`<<<untrusted …>>>`). `createSiteBuilderAgent` registers it; a controller host must pass it
itself (above). The patterns catch common phrasings only, so every rule that must hold is
enforced in the tools rather than asked of the model.

`versions` save passes a publish failure's message to the model only when the host threw a
`PublishError` (a message written for the person); anything else, such as a git host's raw
error, becomes a generic message.

## Isolation

The sandbox only ever receives the site's files. Reference pages are fetched from inside it,
never from Locus's servers. Images come from an OpenAI-compatible endpoint
(`LOCUS_IMAGE_API_KEY`, optional `LOCUS_IMAGE_BASE_URL` and `LOCUS_IMAGE_MODEL`).

## Tests

AIMock plays the model, a fake runtime plays the sandbox, and a temp libSQL file plays the
client database: `pnpm --filter @locus/builder test`.
