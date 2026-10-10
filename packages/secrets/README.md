# @locus/secrets

Where credentials live. The control database stores only a path into this (`secretRef`, e.g.
`/locus/ghl/<organizationId>`), never a value.

- `LocalSecretStore` — local development only: a JSON file (`apps/web/.data/secrets.json`) readable
  by its owner alone. Refuses to run in production.
- `MemorySecretStore` — tests.
- Infisical (`LOCUS_SECRETS=infisical`) — not wired yet; production has no secret store until it is.
