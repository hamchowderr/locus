---
name: site-database
description: Use when a Locus site needs app features that keep data, such as member sign-up and login, bookings or orders it stores itself, saved lists or a members-only area. Covers how to turn on the site's own database and logins (database add), how to add or change tables (a new db/migrations file plus db/schema.ts), how the preview and the published site get the change, and what never to touch.
license: Proprietary (Otaku Solutions)
---

# Site database

Most sites are plain websites and need no database: forms already go to the client's CRM
(site-forms skill), and bookings go to the client's calendar (site-booking skill). Add a
database only when the site has to keep its own records: member accounts, a members-only
area, saved items, or the site's own bookings or orders the person asked for.

## Turning it on
- `database add` makes the site app-style. It is safe to repeat. It adds:
  - `db/schema.ts`: the tables, in Drizzle (`drizzle-orm/sqlite-core`)
  - `db/migrations/0000_logins.sql`: the SQL that creates them
  - `lib/db.ts`: the database client, server code only
  - `lib/auth.ts` and `app/api/auth/[...all]/route.ts`: email and password logins (Better Auth)
  - `lib/auth-client.ts`: for "use client" components (`authClient.signUp.email`,
    `signIn.email`, `signOut`, `useSession`)
  - `instrumentation.ts`, `lib/local-migrations.ts` and `app/api/locus/preview-migrations`:
    these keep the preview's database up to date.
- Then preview. In the preview the database is a throwaway local file, so test sign-ups
  there reach no one.
- The published site gets its own database on Otaku's account the first time it's published.
  Locus applies the migrations, then gives the site its address, key and login secret. Never
  write a database URL, token or secret in code or in `.env` files: the site needs none.

## Changing tables
Every change is two edits in the same step:
1. A new file, `db/migrations/NNNN_short_name.sql`. Take the next number after the highest one
   (`0001_bookings.sql` after `0000_logins.sql`). Use lowercase letters, digits and `_` only.
   It holds plain SQLite. Separate statements with a line holding only
   `--> statement-breakpoint`.
2. The same change in `db/schema.ts`, so the code's types match the database.

Then run `database apply`, or preview, which applies it too. Fix whatever it reports, and use
`check_site` as usual.

Rules that keep the live site's data safe:
- **Never edit or delete a migration that has run** (preview or publish said it applied). If
  it was wrong, fix it with a new migration. Publishing refuses a migration that changed after
  it ran.
- A migration that **failed** didn't run: nothing in it was kept. Fix that same file, then
  apply again. A misnamed file or two files with the same number only need renaming.
- **Keep changes additive.** Add tables, add columns that are nullable or have a default, and
  add indexes. The published site runs its old code until the new version is live, so never
  drop or rename a table or column the current code uses. If something must go, stop using it
  in one version and drop it in a later one.
- Keep the four login tables (`user`, `session`, `account`, `verification`) and their columns
  as they are. To store more about a member, add your own table with a `user_id` column that
  references `user`(`id`).
- Never edit `lib/db.ts`, `lib/local-migrations.ts`, `instrumentation.ts`,
  `app/api/locus/preview-migrations` or the auth route. Locus relies on them as written.
- Never create tables whose names start with `_locus_`, `sqlite_` or `libsql_`.
- Owners and staff can read the site's tables on its Database page. Give any column that holds
  a secret (a key, token or code) a name with `secret` or `token` in it, so the page
  hides it.

Example `db/migrations/0001_bookings.sql`:

```sql
CREATE TABLE `booking` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `day` text NOT NULL,
  `note` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `booking_user_id_idx` ON `booking` (`user_id`);
```

The matching table in `db/schema.ts`:

```ts
export const booking = sqliteTable(
  "booking",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [index("booking_user_id_idx").on(t.userId)],
);
```

## Using it in pages
- Read and write in server components, server actions or route handlers:
  `import { db } from "@/lib/db"` and `import { booking } from "@/db/schema"`, then use
  Drizzle (`db.select().from(booking)`, `db.insert(booking).values(...)`).
- Get the signed-in member on the server with
  `auth.api.getSession({ headers: await headers() })`, using `import { headers } from
  "next/headers"`. Check it in every server action and route that reads or writes a member's
  data, and only touch rows whose `user_id` is that member's.
- Sign-up, sign-in and sign-out forms are "use client" components that use `authClient`.
  Give them labels and clear error messages.
- Never import `lib/db.ts` or `lib/auth.ts` from a "use client" file.
