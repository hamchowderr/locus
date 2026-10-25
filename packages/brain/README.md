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
