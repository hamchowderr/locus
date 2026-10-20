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

The production column describes Otaku's own deployment (its host, app slugs, Turso group and
Infisical paths). Running your own: [`docs/self-hosting.md`](../../docs/self-hosting.md).

| Variable | Locally | Production |
|---|---|---|
| `LOCUS_CONTROL_DB_URL` | `file:.data/control.db` | Turso URL — required |
| `LOCUS_CONTROL_DB_TOKEN` | — | Turso token |
| `BETTER_AUTH_SECRET` | a dev-only default | required |
| `BETTER_AUTH_URL` | `http://localhost:3000` | `https://locus.otakusolutions.io`. A Vercel preview ignores it and uses its own branch URL (`VERCEL_BRANCH_URL`) |
| `EMAIL_MODE` | `console` | `resend`, with `RESEND_API_KEY` and `EMAIL_FROM` |
| `GHL_MODE` | `stub` (a pretend agency with three sub-accounts) | `live` |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_APP_ID` | — | the Marketplace app's. Its scopes are `GHL_SCOPES` in `@locus/connect`, never a setting |
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
| `LOCUS_OPERATORS` | your own email, to try `/operator` | the deployment's operators, comma-separated emails (verified accounts only). They see every agency at `/operator` and can comp one; unset means none |
| `STRIPE_SECRET_KEY` | a **test-mode** key, to try billing | Stripe's secret key. Unset means billing is off and nothing is limited |
| `STRIPE_WEBHOOK_SECRET` | from `stripe listen` | the signing secret of the webhook endpoint `https://<host>/api/auth/stripe/webhook` |
| `LOCUS_SANDBOX_TOKEN`, `LOCUS_SANDBOX_TEAM_ID`, `LOCUS_SANDBOX_PROJECT_ID` | unset: the site builder uses the in-memory fake sandbox (commands succeed and run nothing) | Otaku's own Vercel team, for site sandboxes. Not needed on Vercel, where the deployment's OIDC token is used; `LOCUS_SANDBOX=off` turns sandboxes off |
| `LOCUS_IMAGE_API_KEY` (+ optional `LOCUS_IMAGE_BASE_URL`, `LOCUS_IMAGE_MODEL`) | — | the site builder's image API. Unset means no image generation |
| `COMPOSIO_API_KEY` | — | Otaku's Composio project, for the Apps page (connect Gmail, Google Calendar, Slack per client). Unset means the page says it isn't set up. The agent server needs the same key to use the apps in chat |

Without the required settings, a production deployment shows "Locus is being set up" and the
auth API answers 503 — it never falls back to development defaults.

These values live in Infisical's `otaku-internal` project and reach Vercel through Infisical's
Vercel sync: `dev:/locus` → Preview, `prod:/locus` → Production. Change them in Infisical, not in
Vercel; the sync overwrites Vercel's copy.

## Deploying


Vercel builds with `vercel.json`'s command: `db:migrate`, then `next build`. Each deployment
migrates its own control database before it is built (Production the production database,
Preview the development one), and a migration that fails stops the deployment. The same step
then brings every client's database up to date with `migrateTenants`: on Production, and on
the `staging` branch's Preview. Other Preview builds skip it, so a branch's unmerged migration
never reaches staging's clients.

Agencies' own tokens are not in Infisical: they are sealed in the control database with
`LOCUS_SECRETS_KEY`, which is itself one of those Infisical values.

## Pages

`/sign-up` · `/sign-in` · `/forgot-password` and `/reset-password` · `/onboarding` (create the agency) · `/clients` (pick the client to work
on — the access check runs before it is stored on the session) · `/team` (owners and admins:
invite staff, choose each member's clients) · `/invite/[id]` (accept; verified email required) ·
`/connect` (owners and admins: connect GoHighLevel and sync clients, connect GitHub and Vercel) ·
`/sites` (the active client's sites: anyone who may work on the client creates a site from a
template, which saves version 1; owners and admins link a project from the connected Vercel
team and connect its domain; Locus lists the DNS records to add and checks them) · `/billing` (owners
and admins: the agency's plan, through Stripe) · `/operator` (the deployment's operators: every
agency, and comping one) · `/`

`?next=` on sign-in and sign-up only ever accepts a path on this site (`lib/next-path.ts`).

## Site builder

`lib/site-builder.ts` wires `@locus/builder` to a signed-in member's client; `lib/site-builder-host.ts`
builds it from the environment. The chat API host calls `siteBuilderForClient({ client })` with
the client from `resolveActiveClient`, and gets `{ modes, tools, processors: { output }, resolve,
close }` for the client's `AgentController`. In the chat API's `requestContext` hook it calls
`resolveActiveSiteId(request, member)`: the site the member chose on the Sites page ("Build this
site" sets the httpOnly `locus_site` cookie), returned only if the request's own session may
work on `member.locationId` and the site is that client's, else null. The hook's result becomes
`siteId` (`SITE_ID_KEY`); a host sharing one controller between members also sets that
request's `AuthorizedClient` (`CLIENT_KEY`). The host sets both on every run, overwriting
anything the browser sent.

On every tool call the staff check runs again for the member (removed access stops the next
call), the member's user id is read from the control database, and the site id is checked
against the client's own `site` rows before anything opens; another client's site and a
missing one are refused alike. Then the client's database is borrowed from a per-process pool
(one connection per client, token for that database alone, replaced before the token expires
and closed only once no call uses it), along with the site's sandbox (`<locationId>/<siteId>`,
never given a credential; in production without `LOCUS_SANDBOX_*` the tools answer that previews
aren't set up), images, a credit meter over `checkAllowance`/`recordUsage`, and publishing.

Creating a site: any member who may work on the client; with billing on, the agency needs a plan
and stays within its `sitesPerMonth` (counted from `site.create` audit entries this month, UTC;
soft by concurrent creates).

Publishing: each saved version is committed to the site's GitHub repository (`commitSiteVersion`)
once the site has one, and Vercel deploys the push once it has a project. A site without a
repository is saved in the client's database only; the agent never creates a repository or a
Vercel project, which stay an owner's or admin's step (`ensureSiteRepo`, `ensureSiteDeployment`).
Only Locus's own refusal messages reach the model; GitHub's raw text is logged instead.
The GitHub App's private key comes from the secret store (`github-app-key` script), never the
environment. With `GITHUB_MODE=stub` the stub GitHub and a throwaway key are used.

Each published copy gets `lib/locus.ts` pointing the site's form route at this deployment's
`/api/sites/<siteId>/leads` (`withLocusSettings`, using `BETTER_AUTH_URL`, or the branch URL on
a Vercel preview). That route (`app/api/sites/[siteId]/leads`) takes JSON only, sends no CORS
headers (so only the site's server reaches it, never a browser on another origin) and hands the
body to `submitSiteLead` in `@locus/connect`, which finds the client from the site's row and
writes the lead to its GHL sub-account. See `packages/connect/README.md`.

## Billing

Three monthly plans (`PLANS` in `@locus/auth`, names and limits are placeholders). Each agency
pays Otaku; a person never does. In Stripe, each plan is one recurring monthly price with the
plan's **lookup key** — `locus_starter_monthly`, `locus_growth_monthly`, `locus_scale_monthly` —
so the same code works in test and live mode. Point a webhook endpoint at
`/api/auth/stripe/webhook` with the `checkout.session.completed` and `customer.subscription.*`
events.

Who may do what is read from our own database, never from Stripe during a request: a comped
agency (see `/operator`) or an `active`/`trialing` subscription may add clients up to the plan's
`clients` limit. An overdue agency keeps every client it has but can't add more.
