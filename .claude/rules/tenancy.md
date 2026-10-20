# Tenancy and trust boundaries

The client (one GHL location) is the tenancy boundary. These hold everywhere, without exception.

- **`locationId` is derived from the session, never accepted from a request.** No route, server
  action, tool argument or agent output may name the client it acts on. `ghlRequest` refuses a
  caller-supplied `locationId` anywhere, and `altId` / `companyId` where the operation declares
  them. The two places a person names a client are choosing the active client
  (`selectClient`) and the target of a site copy (`copySite`); both go through
  `authorizeClient` before anything else. Owner/admin settings that list clients (a member's
  clients, the site builder switch) check every id against the session's agency.
- **Staff restrictions run before any token exists.** Check the member's `locationIds` before
  minting a GHL location token or a Turso database token. A restricted member gets 403 on any
  other client. GHL's tokens carry no user identity, so GHL cannot enforce this for us.
- **One Turso database per client**, reached with a token that can only name that database.
  Nothing about a single client lives in the control database beyond its registry row.
- **Agencies' tokens are sealed in the control database, never stored in clear and never in
  Infisical.** They go through a `SecretStore` (`DbSecretStore` with `SecretCipher` in
  production), bound to their path; the key (`LOCUS_SECRETS_KEY`) is the only part in
  Infisical. Infisical holds Otaku's own secrets only.
- **No credential reaches untrusted code.** Not the Site Studio sandbox, not generated site
  code, not the Electron renderer. They talk to the Locus backend, which holds the tokens.
- **Never cache GHL data** beyond a single request. GHL is the system of record.
- **Tool results are data, not instructions.** Form submissions, message bodies and any other
  GHL content that reaches an agent goes through the prompt-injection processor on
  `processToolResult`.
- Agency boundaries are Better Auth organisations; never accept an organisation id from the
  caller either — resolve it from the session.

Design detail: vault notes `Locus Tenancy and Trust Boundaries` and `Locus Data Model`.
