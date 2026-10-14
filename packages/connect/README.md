# @locus/connect

Connecting an agency's GoHighLevel company to Locus, and keeping its clients in step.

- `authorizeUrl` → the agency approves Locus on GHL's **neutral** host
  (`marketplace.leadconnectorhq.com`), never the GoHighLevel-branded one.
- `connectAgency(deps, session, code)` — owners and admins only. Exchanges the code for an
  agency (Company) grant, refuses a sub-account install, keeps the tokens **in the secret store**
  (the database holds only `secretRef`), and registers every sub-account GHL says has Locus
  installed — each gets its own database. Re-running adds nothing twice. One GHL company can be
  connected to only one Locus agency.
- `agencyToken` renews the day-long agency token before it expires.
- `syncLocations` picks up sub-accounts installed since, and reactivates suspended ones that are
  installed again. It never removes one.
- `verifyGhlSignature` + `handleGhlWebhook` — Ed25519 over `X-GHL-Signature`, checked against
  the raw body. `INSTALL` syncs; `UNINSTALL` of a sub-account suspends it (its data stays —
  offboarding is deliberate); `UNINSTALL` of the agency suspends everything and drops the tokens.

- `importStaffAccess` — owners and admins, on request: copies each staff member's client list
  from GHL's agency users (matched by email). A restricted GHL user's sub-accounts become their
  list; an unrestricted GHL admin gets every current client. Owners, admins and roles are never
  changed, and nothing syncs afterwards — GHL is an import source, not an authority. Sub-account
  users (the clients' own logins) aren't staff and are ignored.

## Publishing a client's site (`publish.ts`)

Each saved version of a generated site is committed to a repository in the agency's own GitHub
account, and a project on the agency's own Vercel team builds it.

- Locus acts on GitHub as the **Locus GitHub App**, through the agency's installation. It signs
  a short JWT (RS256, `node:crypto`) with the app's private key and trades it for an
  installation token, scoped to one repository and the permissions the call needs. Tokens are
  kept in memory until five minutes before they expire. The private key comes from an injected
  `GithubAppCredentials` (`privateKey: () => Promise<string>`), supplied by the deployment's
  secret loader: it is never an environment variable.
- `ensureSiteRepo(deps, ctx, client, { siteId, name })` creates a private, empty repository in
  the organization Locus is installed on. GitHub Apps can't create repositories in a personal
  account, so there the agency creates an empty repository, gives the app access, and links it
  with `{ siteId, repoFullName }` (`listInstallationRepos` lists what the app can see). One
  repository per site. Owners and admins only.
- `commitSiteVersion(deps, client, { siteId, files, message, parentSha? })` commits the full
  snapshot to the repository's default branch: text files go inline in the tree, binary ones as
  base64 blobs, and the tree has no base, so a file left out is deleted. An empty repository
  gets its first commit through the contents API (the Git database API answers 409 until then).
  Paths with `..`, absolute paths, anything under `.git/` and any `.env*` file are refused.
  `parentSha` refuses the save if the branch moved. Anyone who may work on the client may save.
- `ensureSiteDeployment(deps, ctx, client, { siteId })` creates a Next.js project on the agency's
  Vercel team, linked to the repository; every push then deploys. If the site already has a
  commit, it asks for the first production deployment too. Vercel's own GitHub app must be able
  to see the repository; if it can't, the agency is told to give it access. Owners and admins
  only.
- `latestDeployment(deps, client, siteId)` gives the latest deployment's state and address, and
  keeps the address on the site once it is ready.

Each change is in the audit log. Another client's site id looks like a missing site.

## Without a GoHighLevel account

`GHL_MODE=stub` (the default outside production) uses `createStubGhl()`: a pretend agency with
three sub-accounts and two staff users (`avery@stub-agency.test`, an admin, and
`sam@stub-agency.test`, restricted to two clients), answering the OAuth and users-search endpoints
as GHL's live docs describe them.

`GITHUB_MODE=stub` and `VERCEL_MODE=stub` (`createStubGithub`, `createStubVercel`) run the
connect flows and the whole publishing flow: installation tokens (the stub checks the JWT's
issuer, `STUB_GITHUB_APP_ID`, not its signature), repository creation, blobs, trees, commits
and refs (409 while a repository is empty, as on GitHub), project creation and deployments. The
stub installation can also see an empty `stub-agency-org/existing-site` to link. A repository
whose name starts with `no-vercel-access` is one the stub Vercel team can't see.

## To check against the real app once it's registered

- The authorize path (`/oauth/chooselocation`) and the AppInstall webhook's field names come
  from GHL's developer guides, not the API export the catalog is built from.
- The webhook signature encoding (base64) — confirm with a real delivery.
- Publishing: the error Vercel returns when its GitHub app can't see a repository (matched on
  its code and message), and the `gitSource` shape of the first deployment request
  (`org`/`repo`/`ref`), were taken from Vercel's docs through search, not a live call.
