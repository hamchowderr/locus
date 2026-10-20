# Searching a site's own records

Read this when an app-style site needs a search box over records it keeps itself: posts,
listings, recipes, members' notes. Searching pages of a plain website needs no database.

The site's database is Turso Cloud through `@libsql/client`, and the preview's is a local
libSQL file. Both are SQLite with libSQL's additions. Use only what this page shows:
guidance written for Turso's newer engine (`@tursodatabase/*`, `CREATE INDEX ... USING fts`,
`fts_match`, `vector32` columns) doesn't run here.

## Keyword search (FTS5)
For a few hundred rows, `like` is enough:
`where title like '%' || ? || '%'`. Past that, or when results should be ranked, add a
full-text table that mirrors the columns to search, kept in step by triggers.

Example `db/migrations/0002_recipe_search.sql`, for a `recipe` table that already exists
(`id integer primary key`, `title`, `body`):

```sql
CREATE VIRTUAL TABLE `recipe_search` USING fts5(
  `title`, `body`, content='recipe', content_rowid='id'
);
--> statement-breakpoint
INSERT INTO `recipe_search` (`rowid`, `title`, `body`) SELECT `id`, `title`, `body` FROM `recipe`;
--> statement-breakpoint
CREATE TRIGGER `recipe_search_insert` AFTER INSERT ON `recipe` BEGIN
  INSERT INTO `recipe_search` (`rowid`, `title`, `body`) VALUES (new.`id`, new.`title`, new.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `recipe_search_delete` AFTER DELETE ON `recipe` BEGIN
  INSERT INTO `recipe_search` (`recipe_search`, `rowid`, `title`, `body`)
  VALUES ('delete', old.`id`, old.`title`, old.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `recipe_search_update` AFTER UPDATE ON `recipe` BEGIN
  INSERT INTO `recipe_search` (`recipe_search`, `rowid`, `title`, `body`)
  VALUES ('delete', old.`id`, old.`title`, old.`body`);
  INSERT INTO `recipe_search` (`rowid`, `title`, `body`) VALUES (new.`id`, new.`title`, new.`body`);
END;
```

- The table being searched needs an integer `id` primary key (`content_rowid`). A table keyed
  by a text id can't be mirrored this way: add the search table in the same migration that
  creates a new table with an integer key, or search it with `like`.
- Each trigger is one statement, so the semicolons inside `BEGIN ... END` stay together. Keep
  the breakpoint line between statements.
- Don't add the search table to `db/schema.ts`: Drizzle can't describe it. Query it with
  Drizzle's `sql`, server side only:

```ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function searchRecipes(words: string) {
  // Quote each word, so a visitor's * " ( or OR is searched for, not run as FTS5 syntax.
  const query = words
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");
  if (!query) return [];
  return db.all<{ id: number; title: string; snippet: string }>(sql`
    select recipe.id, recipe.title,
      snippet(recipe_search, 1, '<mark>', '</mark>', '…', 12) as snippet
    from recipe_search join recipe on recipe.id = recipe_search.rowid
    where recipe_search match ${query}
    order by rank
    limit 20`);
}
```

- Always pass the visitor's words as a parameter (`${query}` inside Drizzle's `sql`), never
  pasted into the string.
- `snippet(...)` marks matches with `<mark>` and `</mark>` in plain text. Split it on those
  marks and render the matched parts in `<mark>` elements; never use `dangerouslySetInnerHTML`
  for it, since the text is whatever visitors or members wrote.
- If a member's records are private, add `and recipe.user_id = ${member.id}` to the `where`.
- The Database page shows the search table but not the tables its index uses.

## Not here
- No "similar items" or AI (vector) search: it needs an embeddings service and a key, and a
  site holds no keys. Say so if asked, and offer keyword search.
- No Turso CLI, platform tokens, `turso` commands or the Vercel Turso integration. Locus makes
  the site's database and its key.
