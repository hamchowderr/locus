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

## Not here yet

- The staff client-access check (`member_location`) before any token is minted.
- `EMAIL_MODE=console|resend`, the Next.js route handler and the sign-up screens.
- The Stripe plugin.
