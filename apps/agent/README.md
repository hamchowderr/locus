# @locus/agent

The agent server: the chat's API (`@locus/agent-api`) for every client of every agency, run as
one long-running process. The agent controller keeps live sessions and approval gates in
memory, and a reply streams over a session's event stream, so it can't run as serverless
functions.

The web app forwards `/api/agent/*` here when `LOCUS_AGENT_URL` is set (see
`apps/web/next.config.ts`). The browser's Better Auth cookie arrives as it does on the web app,
and the same checks run: the signed-in member, their active agency, and the staff check on their
active client, and again before any GoHighLevel or database token is minted for a run. Posts
must be JSON from the web app's own origin, at most 1 MB. An open event stream re-checks access
every 5 seconds and ends when the check fails, so a member removed from a client may still see
up to about 5 seconds of its live chat. Each client's conversations live in that client's own
database, reached with a token that names only it and is renewed while the server runs.

Every client's chat has the site builder as a mode (`@locus/builder/host`). It works on the site
the member chose on the Sites page (kept on their session, re-checked on every tool call). The
agent holds no sandbox credentials: each sandbox call goes to the web app's
`/api/internal/sandbox` with a five-minute token naming the member and client, and the web app
runs the staff check itself (see `packages/sandbox/README.md`). Versions saved from the chat are
published the same way, since only the web app holds the GitHub App: the agent sends the site
and version ids to `/api/internal/publish` (`remotePublish`), and the web app runs the staff
check, reads the version's files from the client's database and commits them to the site's
repository, if it has one.

## Run

```
docker build -f apps/agent/Dockerfile -t locus-agent .
```

| Setting | What it is |
|---|---|
| `LOCUS_CONTROL_DB_URL`, `LOCUS_CONTROL_DB_TOKEN` | The control database, as the web app's |
| `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` | As the web app's; the secret must match to read its sessions |
| `LOCUS_SECRETS_KEY` | Opens agencies' sealed GoHighLevel tokens, as the web app's |
| `TURSO_ORG`, `TURSO_GROUP`, `TURSO_API_TOKEN` | Mint tokens for clients' databases |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_APP_ID` | Renew agencies' GoHighLevel grants |
| `LOCUS_AGENT_MODEL` | The model, as a Mastra model id, e.g. `anthropic/claude-sonnet-5-5`; or `scripted` for a fixed reply with no AI provider (for staging: no key, no cost). With `scripted`, the message `sandbox check` in the Site builder mode runs `node --version` in the chosen site's sandbox, and chats recorded from a real model in `fixtures/recorded/` replay first, except chats that change data, since their writes name the fake sub-account recording used (see `scripts/record-chats.ts`) |
| The model provider's key | e.g. `ANTHROPIC_API_KEY`; not needed with `scripted` |
| `LOCUS_WEB_VERCEL_BYPASS` | Only when the web app is behind Vercel's deployment protection (staging): the project's automation bypass, so the site builder's sandbox calls get through. The route still checks its own token |
| `LOCUS_IMAGE_API_KEY` | Optional: image generation for the site builder, as the web app's |
| `COMPOSIO_API_KEY` | Optional: Otaku's Composio project key. Set, every client's chat can use the apps that client connected (Gmail, Google Calendar, Slack; see `packages/harness/src/apps.ts`); unset, the chat has GHL tools only |
| `PORT` | Defaults to 3000 |

`GET /health` answers `ok`.
