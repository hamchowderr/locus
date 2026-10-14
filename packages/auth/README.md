# @locus/auth

Better Auth for Locus: email and password, and agencies as Better Auth organisations.

```ts
const auth = createAuth({ db, schema, baseURL, secret, sendEmail });
```

- **Email verification is mandatory**, at sign-in and before acting on an invitation
  (`requireEmailVerificationOnInvitation`, advisory GHSA-fmh4-wcc4-5jm3). Don't turn either off.
- `src/cli-config.ts` exists only for Better Auth's CLI, which generates the auth tables into
  `@locus/db`: `pnpm --filter @locus/auth generate:schema`. A test fails if the committed
  output and the config disagree.

## Staff client access

GHL's location tokens carry no user identity, so Locus decides who may work on which client —
before any GHL or Turso token for it exists.

- `authorizeClient(db, session, locationId)`: the agency is the session's active organisation,
  never a caller-supplied id. Owners and admins reach every client of their agency; anyone else
  only the clients listed for them in `member_location` (no rows = none). Anything else is a
  `ClientAccessDenied` (403) with one message, so a foreign client and a missing one look alike.
- `selectClient` stores the choice as the session's `activeLocationId` — the only place a client
  id comes from the user. `resolveActiveClient` re-checks it on every call.
- `listTeam` / `setMemberClients`: owners and admins see the team and replace a member's client
  list; the member and every client must be in the caller's active agency, or nothing changes.
- `mintClientDbToken` takes the result of the check, not a location id, so a token cannot be
  minted without it.

## Email

`emailFromEnv()`: `EMAIL_MODE=console` prints the message (the default outside production),
`EMAIL_MODE=resend` sends through Resend with `RESEND_API_KEY` and `EMAIL_FROM`. Unset in
production is an error, never a silent fallback to the console, and `EMAIL_MODE=console` is refused
in production.

## Billing and operators

- `billing.ts` + `plans.ts`: Better Auth's Stripe plugin, three monthly plans found by lookup
  key, and `agencyEntitlement` / `newClientRefusal`, which read the plan from our own database.
  Off unless the deployment sets `STRIPE_SECRET_KEY`.
- `operator.ts`: the deployment's operators (`LOCUS_OPERATORS`) list every agency and can comp
  one.
- `usage.ts`: credit metering for AI site generation, per client and per agency (below).
- `rate-limit.ts`: attempt limits on sign-in, sign-up and verification emails, counted in the
  control database.

## Usage metering

AI generation (LLM tokens, AI images, sandbox time) is metered in credits. Every amount is an
integer in hundredths of a credit (`CREDIT = 100`); one credit is $0.01 of provider cost × `MARKUP`.
Rates, markup and the plans' credit limits are placeholders until pricing is validated.

- `creditsFor(measurement)`: pure pricing — tokens by model-id prefix (an unknown model is priced
  like the most expensive one), images by size, sandbox by the second. Rounds up.
- `checkAllowance(db, client, { now })` before generating, with the `AuthorizedClient`: refuses
  when the agency isn't entitled, the client is paused, the agency's `creditsPerMonth` or the
  client's own monthly cap is used up, or the client's rolling 5-hour window (`creditsPer5Hours`)
  is full — with a sentence for the user and, when waiting helps, `retryAt`. Months are calendar
  months in UTC, not the Stripe period. Comped agencies have no plan limits; a client's own cap
  still applies.
- `recordUsage(db, client, { usage, … })` after each measurement: stores a `usage_event` and adds
  it to the client's `usage_month` rollup in one batch, and returns alerts newly crossed (the
  client's `alert_at_percent` and 100% of its cap, 80% and 100% of the agency's month). Each fires
  once per month (`usage_alert`), recorded together with its `audit_log` row.
- **Nothing is reserved** between the check and the record, so generations started at the same
  time can each take a total past its limit by about one generation. The next check refuses.
- `usageSummary(db, ctx, { client? })` for the usage page: the whole agency for owners and admins;
  with a `client`, that client only, and the agency's total only for owners and admins.
- `setUsageLimit(db, ctx, client, …)` sets a client's cap, alert threshold or pause — owners and
  admins only, audited.

The agency is always read from the `AuthorizedClient` or the session, never from a request.
Monthly totals come from `usage_month` (a row per client per month); only the 5-hour window sums
events.
