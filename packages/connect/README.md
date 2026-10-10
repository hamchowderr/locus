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

## Without a GoHighLevel account

`GHL_MODE=stub` (the default outside production) uses `createStubGhl()`: a pretend agency with
three sub-accounts that answers the three OAuth endpoints as GHL's live docs describe them.

## To check against the real app once it's registered

- The authorize path (`/oauth/chooselocation`) and the AppInstall webhook's field names come
  from GHL's developer guides, not the API export the catalog is built from.
- The webhook signature encoding (base64) — confirm with a real delivery.
