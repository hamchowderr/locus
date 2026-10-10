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
production is an error, never a silent fallback to the console.

## Not here yet

- The Stripe plugin.
