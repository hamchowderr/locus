# @locus/brain

Each client's brain: markdown notes the agents read for context, holding what GoHighLevel
can't tell us (offers, voice, rules, decisions, work done). Never copies of GHL records, which
are read from GHL when needed.

It is a Mastra workspace filesystem stored in the client's own database, so agents use Mastra's
own file and search tools on it. Mastra has no filesystem over a database (AgentFS opens a local
SQLite file only), so `BrainFilesystem` is ours.

```ts
const brain = new BrainFilesystem(tenantDb, { actor: "agent:main" }); // that client's database only
const workspace = new Workspace({ id: "brain", filesystem: brain, bm25: true });
```

## Layout

- `instructions.md`: how to work with this client.
- `index.md`: every note with a one-line summary, built from the notes on each read.
- Notes are `.md` files inside the fixed folders: `business/`, `people/` (staff only),
  `playbooks/`, `work/`, `decisions/`, `sources/`, `inbox/` (waiting for approval).

Folders aren't stored: the fixed ones always exist and others exist while a note is inside.

## Storage

| Table | Holds |
|---|---|
| `brain_file` | Each note's current content, who changed it last and when |
| `brain_file_version` | Every change, numbered per path; a deletion has no content |

`restoreNoteVersion` writes the old content as a new version, so history only grows.

## Agents

`createBrainWorkspace(db, { needsApproval, authorize, autoSave })` is what the agent server gives every client's
agent: Mastra's file and search tools over the brain, named `brain_read`, `brain_list`,
`brain_grep`, `brain_search`, `brain_write`, `brain_edit` and `brain_delete`, and a processor
(`context`) that puts `instructions.md` and `index.md` in front of the agent on every run.

- Reads never wait. Deleting always waits for a person. A write waits when `needsApproval`
  says so (the host passes its taint check) and always for `instructions.md`.
- What a person tells the agent it saves at once with `brain_write`. A note the agent worked
  out itself goes through `brain_propose` (in `tools`, for the controller), which waits on an
  approval card unless the client's owners turned on auto-save (`autoSave`, read on every
  proposal; Clients page, "Notes the agent works out"). Auto-save never skips the rules above.
- Search is Mastra's BM25 index, built afresh from the notes before a search whenever the
  brain changed, so notes saved anywhere are found. The new index replaces the old one only
  once complete.
- Every brain call, and putting the brain in context, runs the host's staff check first
  (`authorize`). The context is read again whenever the brain changes during a run.
- Ask mode gets the read tools only; every other mode gets them all.

## People

The chat's **Brain** tab (beside Library) lists the sub-account's notes by folder; each opens on
the Brain page (`/brain`, `apps/web/lib/brain.ts`), where a person reads, edits, starts or
deletes a note, and puts any earlier version back. People's changes are saved as `user:<id>`,
so a note's history says who changed what, and agents see a change from their next step. A
restore is a new version, so it can be undone too.

## Starting from the website

A new client's brain is empty, so its context asks the agent to offer, once, to draft starter
notes from the client's website. `createWebsiteReader` (`read_client_website`) reads one page at
a time of the website on the sub-account's GoHighLevel business profile, read live on every
call after the staff check. Every page and redirect must stay on that site's host and resolve
to a public address, and the connection goes to the address that was checked. Ports other
than 80, 443 or the one the website on record names are refused, and markup is read in one
pass. The harness treats what the site says as outside text, so the run that read it is
tainted and every note that run drafts waits for a person's yes. (Like GHL reads, the taint
ends with the run.) The business profile itself is never copied into notes.
