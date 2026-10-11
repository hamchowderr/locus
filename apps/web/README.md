# @locus/web

The product and its API (Next.js). Server-side code reaches the control database and Better Auth
through `lib/locus.ts`; nothing in the browser holds a token.

## Run it locally — no accounts needed

```
pnpm --filter @locus/web db:migrate   # creates apps/web/.data/control.db
pnpm --filter @locus/web dev
```

Email prints to the dev server's log (`EMAIL_MODE=console`), so sign-up works without a mail
provider: open the verification link from the log.

## Configuration

| Variable | Locally | Production |
|---|---|---|
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | — | the machine identity: **the only values set on the deployment** |
| `INFISICAL_PROJECT_ID` | — | the `otaku-internal` project's id |
| `INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH`, `INFISICAL_SITE_URL` | — | default `prod`, `/locus`, `https://app.infisical.com` |
| `LOCUS_CONTROL_DB_URL` | `file:.data/control.db` | Turso URL — required |
| `LOCUS_CONTROL_DB_TOKEN` | — | Turso token |
| `BETTER_AUTH_SECRET` | a dev-only default | required |
| `BETTER_AUTH_URL` | `http://localhost:3000` | `https://locus.otakusolutions.io` |
| `EMAIL_MODE` | `console` | `resend`, with `RESEND_API_KEY` and `EMAIL_FROM` |
| `GHL_MODE` | `stub` (a pretend agency with three sub-accounts) | `live` |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_APP_ID`, `GHL_SCOPES` | — | the Marketplace app's; scopes space-separated |
| `GITHUB_MODE` | `stub` (a pretend org with Locus installed) | `live` |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | — | the GitHub App's (`locus-ghl`) |
| `GITHUB_WEBHOOK_SECRET` | only to test webhooks | the App's webhook secret |
| `VERCEL_MODE` | `stub` (a pretend team) | `live` |
| `VERCEL_INTEGRATION_SLUG`, `VERCEL_INTEGRATION_CLIENT_ID`, `VERCEL_INTEGRATION_CLIENT_SECRET` | — | the Integration's (`locus-otaku`) |
| `GHL_WEBHOOK_PUBLIC_KEY` | only to test webhooks | GHL's Ed25519 key, base64 SPKI or PEM |
| `LOCUS_PROVISIONER` | `local` (`.data/tenants/`, isolates nothing) | `turso` |
| `TURSO_ORG`, `TURSO_GROUP`, `TURSO_API_TOKEN` | — | required for `turso`: the org slug, the `locus` group, a Platform API token |
| `LOCUS_SECRETS` | `local` (`.data/secrets.json`) | `encrypted` — agencies' tokens sealed in the control database |
| `LOCUS_SECRETS_KEY` | only for `encrypted` | required: 32 random bytes, base64 (`openssl rand -base64 32`) |
| `LOCUS_SECRETS_KEY_PREVIOUS` | — | earlier keys, comma-separated, while rotating |

Without the required settings, a production deployment shows "Locus is being set up" and the
auth API answers 503 — it never falls back to development defaults.

In production every other value in this table is read from Infisical (`prod:/locus`, which
imports `/shared`) when a server instance starts (`instrumentation.ts` → `lib/settings.ts`), so
no copy lives in Vercel. A value set on the deployment wins over Infisical's.

Agencies' own tokens are not in Infisical: they are sealed in the control database with
`LOCUS_SECRETS_KEY`, which is itself one of those Infisical values.

## Pages

`/sign-up` · `/sign-in` · `/onboarding` (create the agency) · `/clients` (pick the client to work
on — the access check runs before it is stored on the session) · `/team` (owners and admins:
invite staff, choose each member's clients) · `/invite/[id]` (accept; verified email required) ·
`/connect` (owners and admins: connect GoHighLevel and sync clients, connect GitHub and Vercel) · `/`

`?next=` on sign-in and sign-up only ever accepts a path on this site (`lib/next-path.ts`).
