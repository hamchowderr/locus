# @locus/sandbox

Where Site Studio's agent builds a site: an isolated machine per site holding its Next.js
project, where the agent writes files, installs packages, runs typecheck/lint/build, runs
`next dev` and reads its errors, while the user watches a live preview URL.

```ts
const provider = sandboxFromEnv();            // null when the sandbox env vars are unset
const runtime = await provider.open(siteId);  // one runtime per site, reused while alive
await runtime.writeFiles([{ path: "app/page.tsx", content }]);
await runtime.install();                      // only when package.json changed
const { exitCode, stderr } = await runtime.run("pnpm", ["exec", "tsc", "--noEmit"]);
const { url } = await runtime.startPreview(); // next dev on the first exposed port
const logs = await runtime.previewLogs();     // tail of the dev server's output
```

The interface (`SiteRuntime`, `RuntimeProvider`) is in `src/runtime.ts`.

## Trust boundary

Generated site code and its dependencies are untrusted. **No credential enters the sandbox**:
the Vercel token is used by the Locus backend only, to create and drive the sandbox through
Vercel's API. Commands get a fixed environment (`NEXT_TELEMETRY_DISABLED`, plus `CI` for
installs) and nothing from the backend's own. A test asserts the token appears in no command,
environment or file.

Paths are validated before anything reaches the sandbox: relative only, no `..`, no NUL. Command
output and the preview log are cut to a bounded tail (64k characters by default).

## Providers

- **`VercelRuntimeProvider`** (`@vercel/sandbox`): one named, persistent sandbox per site
  (`locus-site-<hash of key>`) from the `vercel/sandbox/node:<n>` image. Reused in-process per
  key, and found again by name after a restart. A stopped sandbox resumes with its files on the
  next call; its session is extended while in use; one that was deleted or lost its snapshot is
  recreated empty, and `onCreate` lets the caller seed it again. Seeding is complete when
  `.locus/seeded` exists in the project root: until then (a failed or interrupted seeding) every
  open runs `onCreate` again, and no caller gets the runtime before it has finished.
  Command output is streamed into a bounded tail, never held whole in memory; concurrent
  `startPreview` calls share one start.
  `install` runs `pnpm install` (or `npm install` with only a `package-lock.json`) when the hash
  of `package.json` and lockfiles differs from the last successful install.
- **`FakeRuntimeProvider`** (`@locus/sandbox/fake`, also exported from the index): in-memory
  files, a scriptable `(cmd, args, files) => Partial<CommandResult>` handler (exit 0 by default),
  every call in `runtime.calls`, preview URL `https://preview.fake/<key>`, `setPreviewLogs()`.
  It never loads `@vercel/sandbox`.

## Configuration

`sandboxFromEnv()` picks credentials in this order:

1. `LOCUS_SANDBOX_TOKEN`, `LOCUS_SANDBOX_TEAM_ID` and `LOCUS_SANDBOX_PROJECT_ID`, when all three
   are set (an Otaku team-scoped token; needed when Locus runs off Vercel, e.g. on Coolify).
2. On a Vercel deployment (`VERCEL=1`), the deployment's own OIDC token, which the SDK fetches
   through `@vercel/oidc`. Sandboxes then run in the Locus project on Otaku's team, and no secret
   is stored anywhere. This is how staging and production run.
3. Otherwise none: the caller falls back to the fake. `LOCUS_SANDBOX=off` forces this.

`vercel env pull` writes `VERCEL=1` and a development OIDC token into `.env.local`, so a local
run that loads it gets real sandboxes in the Locus project. Set `LOCUS_SANDBOX=off` to keep the
fake locally. A host off Vercel (the Coolify agent server) has no OIDC token and needs the
explicit token if the builder ever runs there.

## Not here yet

- A network policy for the sandbox (today it has open egress, which `pnpm install` needs).
- Syncing the project to and from the site's GitHub repository.
- Reading files back out of the sandbox.
