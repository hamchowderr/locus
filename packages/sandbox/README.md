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
Vercel's API (on Daytona, the same holds for `DAYTONA_API_KEY`). Commands get a fixed environment (`NEXT_TELEMETRY_DISABLED`, plus `CI` for
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
- **`DaytonaRuntimeProvider`** (`@mastra/daytona`, Mastra's workspace sandbox on Daytona): the
  same contract on a named, private Daytona sandbox per site (`locus-site-<hash of key>`,
  `public: false`), made from Daytona's `daytona-medium` snapshot (2 CPUs, 4 GiB, 8 GiB disk, as
  on Vercel; Daytona's default `daytona-small` is too small to install a Next site). A sandbox
  smaller than `resources` (2 and 4) fails with a plain error instead of a killed install;
  deleting it makes it again from the snapshot, without the preview's `.data` (its database and
  members' uploads). Daytona stops an idle sandbox (`autoStopMinutes`, default 30) and keeps its
  files; Mastra starts it again on the next call, including one that stopped under a running
  call (`retryOnDead`). Seeding (`onCreate`, the same `.locus/seeded` marker) runs in Mastra's
  `onStart` hook, so it also covers a sandbox recreated mid-call, and every other call waits for
  it. `install` shares one in-flight install per runtime and takes a `flock` in the sandbox, so
  the web app and the agent server never install at once; the shell running the dev server holds
  a lock while it runs (the dev server itself doesn't inherit it, so nothing it leaves behind
  keeps it), so a second `startPreview` from another process leaves it running. Both locks need
  `flock` (util-linux) in the image; without it they are skipped. `next dev` is spawned in the
  background through Mastra's process manager with no timeout or abort signal, its output in a
  log file (`previewLogs`).
  Deleting a site marks its runtime deleted before the sandbox goes: a call still under way whose
  sandbox vanished can neither find nor create one again (Mastra's `find`/`create` steps refuse,
  and so does the start hook), so a deleted client's files are never seeded anywhere.
  The preview URL is Daytona's **signed preview URL** for the port (expires after
  `previewUrlTtlSeconds`, default 6 h; asked for again on every `startPreview`). It carries no
  API key, but the browser does hold a short-lived preview token. `previewUrl` is the seam for a
  Locus proxy that keeps the token server-side instead (not built yet).
  Files reach the sandbox only through `writeFiles` (the draft in Locus stays the source of
  truth); Mastra's workspace tools are never handed to an agent.
  Tests run the real `DaytonaSandbox` on a fake Daytona client (`createSandbox`), and the install
  and preview scripts for real under `sh` (`installScript`, `previewLaunchScript`).
- **`FakeRuntimeProvider`** (`@locus/sandbox/fake`, also exported from the index): in-memory
  files, a scriptable `(cmd, args, files) => Partial<CommandResult>` handler (exit 0 by default),
  every call in `runtime.calls`, preview URL `https://preview.fake/<key>`, `setPreviewLogs()`.
  It never loads `@vercel/sandbox`.

- **`RemoteRuntimeProvider`**: drives sandboxes through the web app over HTTP, for a backend
  off Vercel (the agent server on Coolify), where Vercel's OIDC token doesn't exist. See
  [Remote sandboxes](#remote-sandboxes).

## Configuration

`sandboxProviderFromEnv()` picks the service with `LOCUS_SANDBOX_PROVIDER`: `vercel` (the
default, so nothing changes until it is set) or `daytona`. `LOCUS_SANDBOX=off` turns either off;
any other value is refused by name. `missingSandboxSettings()` names what the chosen one still
needs.

**Daytona** (`daytonaFromEnv()`) needs `DAYTONA_API_KEY` (Otaku's, in Infisical `/locus`; read
server-side only and given to Daytona's client, never to a sandbox). Optional: `DAYTONA_API_URL`,
`DAYTONA_TARGET` (region), `DAYTONA_SNAPSHOT` (default `daytona-medium`; a prepared snapshot of
at least 2 CPUs and 4 GiB), and `LOCUS_SANDBOX_EGRESS`, a
comma-separated domain allowlist for sandboxes created after it is set (unset: open egress, as on
Vercel). Daytona needs no OIDC token, so the agent server opens its sandboxes itself instead of
going through the web app's sandbox route.

**Vercel Sandbox**: `sandboxFromEnv()` picks credentials in this order:

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

## Remote sandboxes

Vercel Sandbox authenticates only inside `apps/web` on Vercel (the deployment's OIDC token). A
backend elsewhere drives sandboxes through the web app's `POST /api/internal/sandbox` instead,
with no new credential:

```ts
import { agentToWebKey, mintAgentToWebToken } from "@locus/auth";
// One provider per member and client; the claims come from that member's checked session.
const provider = remoteSandboxFromEnv(process.env, () =>
  mintAgentToWebToken(agentToWebKey(process.env.BETTER_AUTH_SECRET), {
    memberId, locationId, organizationId,
  }),
); // null unless LOCUS_SANDBOX_URL is set
const runtime = await provider.open(siteId); // a site id, not a sandbox key
```

- `RemoteRuntimeProvider({ url, mintToken, fetch?, maxBodyBytes? })` implements `SiteRuntime`
  faithfully: each method is one JSON POST, `{ siteId, op, args }`, with
  `Authorization: Bearer <token>`. Results come back as the local runtime returns them (outputs
  already cut to their tail). Errors come back as `{ name, message }`, never a stack:
  `InvalidPathError` is rebuilt as itself, anything else is a `RemoteSandboxError` with the same
  message (`remoteName`, `status`). `writeFiles` is split into batches under the body cap (4 MiB,
  under Vercel's 4.5 MB request limit); a single file over it is refused. The runtime's `id` is
  `remote-<siteId>`: the real one (a sandbox name) never leaves the web app.
  The route's function is killed at 300 s, so the handler cuts each command at
  `MAX_CALL_COMMAND_MS` (240 s; reported as `timedOut`), and `install` resumes an install the
  cut stopped, up to three calls.
- `remoteSandboxFromEnv(env, mintToken)`: a provider when `LOCUS_SANDBOX_URL` (the web app's base
  URL) is set, else null.
  The agent server doesn't use it: its site builder calls `remoteSiteRuntimes` from
  `@locus/builder/host`, pointed at `BETTER_AUTH_URL` (the web app), which mints a token per call
  for the member and client.
- `handleSandboxRequest(request, { provider, authenticate, sandboxKey, maxBodyBytes? })`: the
  framework-free server side. `authenticate(token)` runs first (null: a bare 404, the same for
  every unauthenticated request, before the body is read); then a stream-bounded body read (413
  over the cap), a known op and checked args (400), and `sandboxKey(principal, siteId)` (null:
  403) — all before `provider.open(key)`. Bodies are never logged.

The token (`mintAgentToWebToken`, `@locus/auth`) is an HS256 JWT keyed by HKDF from
`BETTER_AUTH_SECRET` under the label `locus-agent-to-web` (not the chat kit's key, so neither
token works in the other direction), valid at most 10 minutes: `sub` is the member id, plus the
client (`loc`) and agency (`org`). The body never names a client or a sandbox key. On every call
`apps/web/lib/sandbox-rpc.ts` loads the member, requires the token's agency, runs the staff check
for that client (`authorizeClient`), checks the site is that client's, and only then derives the
key as the in-process builder does (`siteRuntimeKey`).

**apps/web must never serve this route without those checks**: anyone who can call it can run
commands in a site's sandbox. In production the route answers 404 unless `BETTER_AUTH_SECRET` is
set and real sandboxes are configured. **No credential travels to the sandbox**: the token stops
at the web app, and the Vercel credentials never leave it.

## Not here yet

- A network policy for the Vercel sandbox (today it has open egress, which `pnpm install`
  needs). Daytona's is `LOCUS_SANDBOX_EGRESS`, off by default.
- A Locus proxy for Daytona previews, so the preview token never reaches the browser.
- Syncing the project to and from the site's GitHub repository.
- Reading files back out of the sandbox.
