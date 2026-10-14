# Locus

An AI-native system around GoHighLevel for agencies: one place to work across every client's
GHL sub-account, and (next) to generate and host their sites.

An **agency** (a GHL *Company*) signs up, connects its GoHighLevel company, and Locus registers
each **client** (one GHL *location*, a "sub-account" in the UI) with its own database. Staff see
only the clients they are given.

## What works today

- **Accounts.** Email and password sign-up with mandatory email verification, forgot and reset
  password, invitations for staff, and rate limits on sign-in, sign-up and verification emails
  (counted per IP, per email, and per email and IP, in the control database).
- **Agencies and staff.** Owners and admins invite staff and choose which clients each member
  may work on (`/team`), or import that list from GHL's agency users. A member picks the client
  to work on at `/clients`, and the access check runs on every request.
- **Connections** (`/connect`, owners and admins):
  - **GoHighLevel**, through a Marketplace app installed by the agency. Every sub-account with
    Locus installed becomes a client; install and uninstall webhooks keep the list in step.
  - **GitHub**, through a GitHub App installed on the agency's organisation.
  - **Vercel**, through a Vercel Integration installed on the agency's team.
- **Sites** (`/sites`): link a client's site to a project on the agency's Vercel team and
  connect its custom domain. Locus lists the DNS records to add at the client's DNS provider
  and checks them.
- **Billing** (`/billing`): three monthly plans through Stripe. An agency needs a plan to add
  clients, and the Starter plan caps them at five. Optional: without a Stripe key billing is
  off and nothing is limited.
- **Operator page** (`/operator`): the deployment's operators see every agency and can comp
  one (free access without a subscription).
- **Agent harness** (`packages/harness`): a Mastra agent with `query_data` and
  `perform_action` tools over the generated GHL skill catalog. It is a library today and not
  yet exposed in the web app.

Agencies' tokens (GHL, Vercel) are sealed with AES-256-GCM in the control database, and nothing
in the browser or the desktop app ever holds one.

## Layout

```
apps/web          Next.js: the product and its API
apps/desktop      Electron thin client of apps/web (holds no tokens)
packages/auth     Better Auth: accounts, agencies, staff access, billing, operators
packages/connect  GoHighLevel, GitHub and Vercel connections, sites and domains
packages/db       Drizzle schema and migrations: one control DB, one DB per client
packages/secrets  where agencies' credentials are sealed
packages/ghl      operation descriptors and the one GHL request path
packages/skills   the GHL skill catalog, generated from GHL's docs
packages/harness  the Mastra agent and its tools
packages/testing  AIMock wiring and a fake GHL for tests
packages/ui       shared shadcn components
```

Each package has its own README with the details.

## Develop

Requires Node 22.18+ and pnpm 10. Nothing else: outside production every outside service has a
stand-in (a pretend GHL agency, GitHub org and Vercel team, email printed to the log, SQLite
files for the databases).

```
pnpm install
pnpm --filter @locus/web db:migrate   # creates apps/web/.data/control.db
pnpm --filter @locus/web dev          # http://localhost:3000
pnpm --filter @locus/desktop dev      # Electron, loads LOCUS_URL (default localhost:3000)
```

Sign up, then open the verification link printed in the dev server's log. See
[`apps/web/README.md`](apps/web/README.md) for every setting.

Before a pull request, run what CI runs:

```
pnpm check && pnpm --filter @locus/skills generate:check && pnpm typecheck && pnpm test && pnpm build
```

## Self-hosting

[`docs/self-hosting.md`](docs/self-hosting.md) covers the services to set up, the settings
each one needs, deploying, and the webhooks to register.

## More

Product docs live in Otaku's private Obsidian vault; start with the PRD's "What changed in
v0.5". Agent and contributor rules: [`CLAUDE.md`](CLAUDE.md).
