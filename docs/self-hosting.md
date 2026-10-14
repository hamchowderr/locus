# Self-hosting Locus

How to run your own Locus deployment: the outside services to set up, the settings each needs,
deploying the web app, and the webhooks to register. This document names settings only; it
never holds a value. Keep your values in a secret manager, not in the repository.

To try Locus without any of this, run it locally (see the [README](../README.md#develop)):
every outside service has a stand-in outside production.

## What a deployment is

- **One web app**, `apps/web` (Next.js), which serves both the product and its API.
- **One control database** (Turso / libSQL): accounts, agencies, the client registry, staff
  access, connections, sites, billing state, rate-limit counters, and agencies' tokens, sealed.
- **One database per client**, created on demand through the Turso Platform API.
- **Outside services**, each optional or required as listed below: GoHighLevel, GitHub,
  Vercel, Stripe and an email provider (Resend).

In production (`NODE_ENV=production`) Locus does not fall back to the GoHighLevel, GitHub,
Vercel, database or secrets stand-ins. When a server instance starts, its log names each
missing setting from the table below that it checks (names only, never values). What a missing
setting does:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` or `LOCUS_CONTROL_DB_URL`: every page shows "Locus is
  being set up" and the auth API answers 503.
- Email (`EMAIL_MODE` unset or `console`, `RESEND_API_KEY`, `EMAIL_FROM`): pages and the auth API fail with a
  server error.
- Anything else (GoHighLevel, GitHub, Vercel, Turso, `LOCUS_SECRETS_KEY`): only that feature
  fails, for example connecting GoHighLevel or adding a client.

## Settings

Every setting the web app reads in production, by what it is for. "Required" means the
deployment is not considered set up without it.

| Setting | Required | What it is |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | Signs sessions. 32 or more random bytes, e.g. `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | yes | The deployment's public URL, e.g. `https://locus.example.com`. Used for email links, OAuth callbacks and Stripe return pages |
| `LOCUS_CONTROL_DB_URL` | yes | The control database's `libsql://` URL |
| `LOCUS_CONTROL_DB_TOKEN` | yes | A token for the control database |
| `EMAIL_MODE` | yes | `resend` in production. `console` (prints messages to the log) is for development and is refused in production |
| `RESEND_API_KEY` | yes | Resend API key |
| `EMAIL_FROM` | yes | The sender, e.g. `Locus <no-reply@example.com>`, on a domain verified in Resend |
| `LOCUS_SECRETS` | no | `encrypted`, the default and only choice in production |
| `LOCUS_SECRETS_KEY` | yes | Seals agencies' tokens. 32 random bytes, base64 (`openssl rand -base64 32`) |
| `LOCUS_SECRETS_KEY_PREVIOUS` | no | Earlier keys, comma-separated, only while rotating |
| `LOCUS_PROVISIONER` | no | `turso`, the default and only choice in production |
| `TURSO_ORG` | yes | Your Turso organisation slug |
| `TURSO_GROUP` | yes | The Turso group client databases are created in |
| `TURSO_API_TOKEN` | yes | A Turso Platform API token |
| `GHL_MODE` | no | `live`, the default in production |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_APP_ID` | yes | Your GoHighLevel Marketplace app's |
| `GHL_WEBHOOK_PUBLIC_KEY` | for webhooks | GoHighLevel's Ed25519 webhook public key, base64 SPKI or PEM |
| `GITHUB_MODE` | no | `live`, the default in production |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | yes | Your GitHub App's |
| `GITHUB_WEBHOOK_SECRET` | yes | The GitHub App's webhook secret |
| `VERCEL_MODE` | no | `live`, the default in production |
| `VERCEL_INTEGRATION_SLUG`, `VERCEL_INTEGRATION_CLIENT_ID`, `VERCEL_INTEGRATION_CLIENT_SECRET` | yes | Your Vercel Integration's |
| `STRIPE_SECRET_KEY` | no | Turns billing on. Unset means billing is off and agencies are not limited |
| `STRIPE_WEBHOOK_SECRET` | with Stripe | The signing secret of your Stripe webhook endpoint |
| `LOCUS_OPERATORS` | no | Comma-separated emails of the deployment's operators (verified accounts only). Unset means nobody can open `/operator` |

The `GHL_MODE`, `GITHUB_MODE` and `VERCEL_MODE` switches exist so development can use
stand-ins; in production leave them unset or set them to `live`. Set to `stub` in production,
they are logged as a problem and refused. `EMAIL_MODE=console` is refused the same way.

GoHighLevel's OAuth scopes are not a setting: they are `GHL_SCOPES` in
[`packages/connect/src/ghl-scopes.ts`](../packages/connect/src/ghl-scopes.ts), and your app
must have exactly those ticked. (The app id in that file's comment is Otaku's own app, not one
you need.)

## 1. Turso: the databases

1. Create a Turso organisation (or use yours) and a **group** in the region you want. Its name
   is `TURSO_GROUP`; the organisation slug is `TURSO_ORG`.
2. Create the **control database** in that group and a token for it. Its URL and token are
   `LOCUS_CONTROL_DB_URL` and `LOCUS_CONTROL_DB_TOKEN`.
3. Create a **Platform API token** for `TURSO_API_TOKEN`. Locus uses it to create a database
   for each client, mint tokens scoped to one database, and delete a client's database when it
   is offboarded. Limit it to those permissions if your plan allows.

The control database is migrated on every deploy (see [Deploy](#6-deploy)). Client databases
are created empty and migrated by Locus itself when a client is added.

## 2. Accounts and email

Accounts are Better Auth (email and password). It needs no outside account, only
`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.

- Email verification is mandatory, and invitations require a verified email.
- Forgot password sends a reset link (at most a few per account per hour), and a reset signs
  out every session.
- Sign-in, sign-up and verification emails are rate limited per IP, per email, and per email
  and IP. The counters live in the control database, so they hold across instances. The IP is
  read from `x-forwarded-for`, which must hold only the client's address (Vercel's does). A
  proxy that appends to the header makes the IP unreadable, and only the per-email limits
  apply.

For email, create a [Resend](https://resend.com) account, verify the domain you send from, and
set `EMAIL_MODE=resend`, `RESEND_API_KEY` and `EMAIL_FROM`.

Changing `BETTER_AUTH_SECRET` signs everyone out. Losing `LOCUS_SECRETS_KEY` loses every
agency's connections: they would have to reconnect. Back both up; to rotate the secrets key
see [`packages/secrets/README.md`](../packages/secrets/README.md#rotating-the-key).

## 3. GoHighLevel: the Marketplace app

Agencies connect their GoHighLevel company through your own Marketplace app.

1. In the [GoHighLevel developer portal](https://marketplace.gohighlevel.com), create an app
   whose target user is **Sub-Account** and which agencies install (distribution: agency).
2. Tick exactly the scopes in `GHL_SCOPES` (see above).
3. Add the redirect URL `https://<your host>/api/connect/crm/callback`. Add one per
   deployment (for example production and staging).
4. Create a client key. The client id, client secret and the app's id are `GHL_CLIENT_ID`,
   `GHL_CLIENT_SECRET` and `GHL_APP_ID`.
5. Set the app's webhook URL to `https://<your host>/api/webhooks/crm` and subscribe to the
   **AppInstall** and **AppUninstall** events. Put GoHighLevel's webhook public key in
   `GHL_WEBHOOK_PUBLIC_KEY`.

Agencies approve the app on GoHighLevel's neutral host (`marketplace.leadconnectorhq.com`).
Installing on a sub-account syncs it in as a client; uninstalling suspends it (its data stays),
and uninstalling from the agency suspends every client and drops the agency's tokens.

## 4. GitHub: the GitHub App

1. Create a [GitHub App](https://github.com/settings/apps/new) (on your organisation or
   account). Its URL name is `GITHUB_APP_SLUG`.
2. Set the callback URL to `https://<your host>/api/connect/github/callback` and tick
   **Request user authorization (OAuth) during installation**.
3. Set the webhook URL to `https://<your host>/api/webhooks/github` with a random webhook
   secret (`GITHUB_WEBHOOK_SECRET`). Locus acts on the `installation` event: when an agency
   uninstalls the app, its link is removed.
4. Make the app installable by any account, so agencies can install it on their own
   organisation.
5. Generate a client secret. The client id and secret are `GITHUB_APP_CLIENT_ID` and
   `GITHUB_APP_CLIENT_SECRET`.
6. Give the app these repository permissions, so Locus can publish clients' sites to the
   agency's GitHub:
   - **Contents: read and write**: each saved version of a site is committed to its repository.
   - **Administration: read and write**: Locus creates a private repository for each site in
     the agency's organization.
   - **Metadata: read** (GitHub requires it): Locus lists the repositories the agency gave the
     app, so one can be linked to a site.
7. Generate a **private key** for the app. Locus signs a short-lived token with it to act as
   the app on an agency's installation. Note the app's **App ID** too; GitHub accepts either the
   client id (which it recommends) or the App ID as the token's issuer.

Locus checks that the installation is one the installing user can access before linking it,
and keeps no user token.

The App's private key is never an environment variable, in this table or anywhere else. Your
deployment's secret loader supplies it to Locus when Locus needs to sign (Locus asks for it
through `GithubAppCredentials.privateKey`), and Locus keeps it only for that moment. Keep it in
your secret manager.

GitHub Apps can't create repositories in a personal account. An agency that installed the app
on a personal account creates an empty private repository itself, gives the app access to it,
and picks it in Locus.

## 5. Vercel: the Integration

Agencies host their clients' sites on their own Vercel team through your Vercel Integration.

1. In the [Vercel Integration Console](https://vercel.com/dashboard/integrations/console),
   create an integration. Its URL slug is `VERCEL_INTEGRATION_SLUG`.
2. Set the Redirect URL to `https://<your host>/api/connect/vercel/callback`. It must match
   exactly.
3. Give it read and write access to **projects**, **deployments** and **domains**: the Sites
   page lists the team's projects, creates one for each published site, shows its latest
   deployment, adds a client's domain to it, and reads the domain's DNS configuration.
4. The integration's client id and secret are `VERCEL_INTEGRATION_CLIENT_ID` and
   `VERCEL_INTEGRATION_CLIENT_SECRET`.

The team's token is sealed in the control database. A client's domain stays at the client's own
DNS provider: Locus shows the records to add there and checks them.

A published site's Vercel project builds the site's repository in the agency's GitHub, so each
agency's Vercel team must be linked to GitHub: Vercel's own GitHub app has to be installed on
the agency's GitHub account with access to the site repositories (or to all repositories). If
it can't see a repository, Locus says so and asks the agency to give it access.

## 6. Deploy

Locus is built for Vercel, but any host that runs Node 22.18+ and Next.js works. (The
migration script runs TypeScript directly, which Node supports from 22.18.)

### On Vercel

1. Import the repository as a project and set its **Root Directory** to `apps/web`. Vercel
   detects pnpm from the lockfile.
2. Add every setting above to the project's environment (Production, and Preview if you use
   one).
3. Deploy. `apps/web/vercel.json` runs `pnpm db:migrate && pnpm build`: each deployment
   migrates its own control database before it is built, and a failed migration stops the
   deployment.
4. Add your domain to the project and set `BETTER_AUTH_URL` to it.

A **Preview** deployment uses its branch URL (`VERCEL_BRANCH_URL`) as its own address rather
than `BETTER_AUTH_URL`, so every branch has one fixed address you can register as an extra
callback or webhook URL. Give previews their own control database and Stripe test-mode keys,
never production's. If you turn on Vercel's Deployment Protection, scripted requests and
outside webhooks need a protection bypass for that deployment.

### Elsewhere

```
pnpm install --frozen-lockfile
pnpm --filter @locus/web db:migrate   # with the settings above in the environment
pnpm turbo run build --filter=@locus/web
pnpm --filter @locus/web start        # NODE_ENV=production, behind a TLS proxy
```

Run `db:migrate` before starting each new version. The proxy in front must set
`x-forwarded-for` to the client's address alone (see the rate limits above).

## 7. Stripe: billing (optional)

Without `STRIPE_SECRET_KEY`, billing is off and agencies may add any number of clients. With
it on, an agency needs a plan (or a comp) before it can add a client. To turn it on:

1. In Stripe, create one product per plan with one **recurring monthly price** each, and give
   each price the plan's **lookup key**: `locus_starter_monthly`, `locus_growth_monthly` and
   `locus_scale_monthly` (the plans and their client limits are `PLANS` in
   [`packages/auth/src/plans.ts`](../packages/auth/src/plans.ts)). Lookup keys mean the same
   code works in test and live mode.
2. Add a webhook endpoint at `https://<your host>/api/auth/stripe/webhook` with the events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`. Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY`. Use test-mode keys anywhere but production.

Locus reads an agency's plan from its own database, never from Stripe during a request. An
agency with an `active` or `trialing` subscription, or one an operator comped at `/operator`,
may add clients up to its plan's limit. An overdue agency keeps its clients but can't add more.

## Webhooks at a glance

| From | URL | Verified with |
|---|---|---|
| GoHighLevel | `/api/webhooks/crm` | `GHL_WEBHOOK_PUBLIC_KEY` (Ed25519 over `X-GHL-Signature`) |
| GitHub | `/api/webhooks/github` | `GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256`) |
| Stripe | `/api/auth/stripe/webhook` | `STRIPE_WEBHOOK_SECRET` |

Each checks the signature against the raw body before reading anything. The GoHighLevel and
GitHub webhooks answer 503 while their setting is missing; Stripe's answers with an error.

## Callback URLs at a glance

| Service | Redirect / callback URL |
|---|---|
| GoHighLevel | `/api/connect/crm/callback` |
| GitHub | `/api/connect/github/callback` |
| Vercel | `/api/connect/vercel/callback` |

## After the first deploy

1. Sign up at `/sign-up` and verify your email.
2. Add your email to `LOCUS_OPERATORS` and redeploy, if you want the operator page.
3. Create your agency at `/onboarding`, then connect GoHighLevel, GitHub and Vercel at
   `/connect`.
4. Check the deployment's log for any line naming a missing setting.
