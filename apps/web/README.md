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
| `LOCUS_CONTROL_DB_URL` | `file:.data/control.db` | Turso URL — required |
| `LOCUS_CONTROL_DB_TOKEN` | — | Turso token |
| `BETTER_AUTH_SECRET` | a dev-only default | required |
| `BETTER_AUTH_URL` | `http://localhost:3000` | `https://locus.otakusolutions.io` |
| `EMAIL_MODE` | `console` | `resend`, with `RESEND_API_KEY` and `EMAIL_FROM` |

Without the required settings, a production deployment shows "Locus is being set up" and the
auth API answers 503 — it never falls back to development defaults. Secrets come from Infisical
(`/locus`).

## Pages

`/sign-up` · `/sign-in` · `/onboarding` (create the agency) · `/clients` (pick the client to work
on — the access check runs before it is stored on the session) · `/`
