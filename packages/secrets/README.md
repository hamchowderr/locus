# @locus/secrets

Where agencies' credentials live: GHL tokens today, Vercel and GitHub tokens next. Each is
addressed by a path (`secretRef`, e.g. `/locus/ghl/<organizationId>`).

- **`encrypted`** (production, `LOCUS_SECRETS=encrypted`): sealed with AES-256-GCM by
  `SecretCipher` and stored in the control database's `secret` table (`DbSecretStore` in
  `@locus/db`). Each value is bound to its path, so a sealed value copied onto another agency's
  row fails to open. The key, `LOCUS_SECRETS_KEY`, lives in Infisical `/locus`, never in the
  database: a leaked database alone leaks no token, and nobody browsing Infisical sees agencies'
  tokens.
- **`local`** (the development default): a JSON file (`apps/web/.data/secrets.json`) readable by
  its owner alone. Refuses to run in production.
- `MemorySecretStore` — tests.

Otaku's own secrets (the GHL app secret, Turso and Resend keys, the auth secret) are not here;
they are Infisical values read at startup.

## Rotating the key

1. Put a new key in `LOCUS_SECRETS_KEY` and the old one in `LOCUS_SECRETS_KEY_PREVIOUS`.
2. Every value read from then on is re-sealed under the new key.
3. Once no row still carries the old key's id (the second field of `sealed`), drop
   `LOCUS_SECRETS_KEY_PREVIOUS`.

Losing `LOCUS_SECRETS_KEY` loses every agency's connection: they would have to reconnect.
