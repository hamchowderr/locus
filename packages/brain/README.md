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

`createBrainWorkspace(db, { needsApproval })` is what the agent server gives every client's
agent: Mastra's file and search tools over the brain, named `brain_read`, `brain_list`,
`brain_grep`, `brain_search`, `brain_write`, `brain_edit` and `brain_delete`, and a processor
(`context`) that puts `instructions.md` and `index.md` in front of the agent on every run.

- Reads never wait. Deleting always waits for a person. A write waits when `needsApproval`
  says so (the host passes its taint check) and always for `instructions.md`.
- Search is Mastra's BM25 index, rebuilt from the notes before a search whenever the brain
  changed, so notes saved anywhere are found.
- Ask mode gets the read tools only; every other mode gets them all.
