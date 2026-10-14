# @locus/builder

The site builder: the tools and instructions an agent uses to build and change a client's
Next.js site. It plugs into the shared Mastra `AgentController` as a mode, or runs as its own
agent.

```ts
const mode = siteBuilderMode({ resolve });               // AgentController mode
const agent = createSiteBuilderAgent({ model, resolve }); // standalone (subagent, tests)
```

`resolve(requestContext)` is the host's: from the signed-in session it finds the client, checks
the site belongs to that client, opens that client's database and the site's sandbox, and
returns a `BuilderSession`. Every tool call goes through it, so nothing the model says can
point a tool at another site or client.

## Tools

| Tool | Does |
|---|---|
| `get_brief` / `update_brief` | The design brief and the design questions still open |
| `list_files` `read_file` `write_file` `edit_file` `delete_files` | The site's draft, in its client's database (`@locus/studio`) |
| `run_command` | One command in the site's sandbox, after syncing the draft |
| `add_dependency` | Adds an npm package at its exact current version and installs |
| `check_site` | Install + `next build`; returns ok or the errors to fix |
| `preview` / `read_preview_logs` | The live preview URL and the dev server's output |
| `fetch_reference` | Reads a reference site's outline, fetched inside the sandbox |
| `generate_image` | An original PNG into `public/`, from `ImageGenerator` |
| `save_version` / `list_versions` / `restore_version` | Versions; a save calls `onVersionSaved` (e.g. commit to the agency's GitHub) |

Mistakes the model can fix (a refused path, a failed build, no credits left) come back as
`{ error }`. Sandbox work and images are checked against the client's credits first
(`UsageMeter.check`) and recorded after (`UsageMeter.record`); the host meters LLM tokens.

The sandbox only ever receives the site's files. Reference pages are fetched from inside it,
never from Locus's servers. Images come from an OpenAI-compatible endpoint
(`LOCUS_IMAGE_API_KEY`, optional `LOCUS_IMAGE_BASE_URL` and `LOCUS_IMAGE_MODEL`).

## Tests

AIMock plays the model, a fake runtime plays the sandbox, and a temp libSQL file plays the
client database: `pnpm --filter @locus/builder test`.
