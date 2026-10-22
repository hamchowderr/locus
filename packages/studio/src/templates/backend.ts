import {
  MAX_LARGE_SITE_FILE_BYTES,
  MAX_SITE_FILE_BYTES,
  MAX_SITE_VIDEO_BYTES,
  SITE_DATABASE_ENV,
  SITE_FILE_TYPES,
  SITE_MIGRATIONS_DIR,
  SITE_MIGRATIONS_TABLE,
  SITE_VIDEO_TYPES,
  STATEMENT_BREAKPOINT,
} from "@locus/db";
import type { SiteFile } from "../workspace.ts";
import { LOCUS_SETTINGS_PATH, locusSettingsFile } from "./forms.ts";

// What an app-style site adds to the base project: its own database and logins.
//
//   sandbox preview → a SQLite file in the sandbox (.data/site.db), no token anywhere
//   published site  → its Turso database, from env vars Locus sets on its host at publish
//
// The schema lives in the site's source: `db/schema.ts` for the app's code and numbered SQL
// files in `db/migrations/` for the database. In the preview the site applies them to its file
// itself (`lib/local-migrations.ts`); for the published site Locus applies them when it
// publishes, with the same ledger (`@locus/db`'s `applySiteMigrations`).

/** Exact versions, matching what Locus itself runs. */
export const BACKEND_STACK = {
  "@libsql/client": "0.18.0",
  "better-auth": "1.7.7",
  "drizzle-orm": "0.45.4",
} as const;

export { SITE_DATABASE_ENV };

export const SITE_SCHEMA_PATH = "db/schema.ts";
export const FIRST_MIGRATION_PATH = `${SITE_MIGRATIONS_DIR}/0000_logins.sql`;

const LOCAL_DB = ".data/site.db";

const timestamps = `  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`)
    .$onUpdate(() => new Date())
    .notNull(),`;

const schemaFile = (): SiteFile => ({
  path: SITE_SCHEMA_PATH,
  content: `import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The site's tables. Every change here comes with a new numbered file in db/migrations/ that
// makes the same change to the database; never edit a migration that has already run.

// Logins (Better Auth). Keep these four tables and their columns as they are.
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
${timestamps}
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
${timestamps}
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
${timestamps}
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
${timestamps}
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// The site's own tables go below.
`,
});

const now = "(cast(unixepoch('subsecond') * 1000 as integer))";
const stamps = `\`created_at\` integer DEFAULT ${now} NOT NULL,
  \`updated_at\` integer DEFAULT ${now} NOT NULL`;

/** The SQL for the four login tables; matches `db/schema.ts`. */
export const LOGINS_MIGRATION = [
  `CREATE TABLE \`user\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`name\` text NOT NULL,
  \`email\` text NOT NULL,
  \`email_verified\` integer DEFAULT false NOT NULL,
  \`image\` text,
  ${stamps}
);`,
  "CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);",
  `CREATE TABLE \`session\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`expires_at\` integer NOT NULL,
  \`token\` text NOT NULL,
  \`ip_address\` text,
  \`user_agent\` text,
  \`user_id\` text NOT NULL,
  ${stamps},
  FOREIGN KEY (\`user_id\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade
);`,
  "CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);",
  "CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);",
  `CREATE TABLE \`account\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`account_id\` text NOT NULL,
  \`provider_id\` text NOT NULL,
  \`user_id\` text NOT NULL,
  \`access_token\` text,
  \`refresh_token\` text,
  \`id_token\` text,
  \`access_token_expires_at\` integer,
  \`refresh_token_expires_at\` integer,
  \`scope\` text,
  \`password\` text,
  ${stamps},
  FOREIGN KEY (\`user_id\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade
);`,
  "CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);",
  `CREATE TABLE \`verification\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`identifier\` text NOT NULL,
  \`value\` text NOT NULL,
  \`expires_at\` integer NOT NULL,
  ${stamps}
);`,
  "CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);",
].join(`\n${STATEMENT_BREAKPOINT}\n`);

const dbFile = (): SiteFile => ({
  path: "lib/db.ts",
  content: `import { mkdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";

// Server code only: never import this from a "use client" file. On the published site the
// database comes from env vars Locus sets on the host. In the preview (next dev) it is a local
// file, and the preview has no token at all. A production server without them refuses to start
// rather than quietly keeping members in a throwaway file. \`next build\` loads this file too, and
// a check build in the sandbox has no database: it gets an empty in-memory one.
const url = process.env.${SITE_DATABASE_ENV.url};
const building = process.env.NEXT_PHASE === "phase-production-build";

export const isPreviewDatabase = !url && process.env.NODE_ENV !== "production";

if (!url && !isPreviewDatabase && !building) {
  throw new Error("${SITE_DATABASE_ENV.url} is not set. Publish the site from Locus to set it.");
}
if (isPreviewDatabase) mkdirSync(".data", { recursive: true });

export const client = createClient(
  url
    ? { url, authToken: process.env.${SITE_DATABASE_ENV.token} }
    : { url: isPreviewDatabase ? ${JSON.stringify(`file:${LOCAL_DB}`)} : ":memory:" },
);

export const db = drizzle(client, { schema });
`,
});

/** The preview's migration runner. Same ledger, hashing and splitting as `applySiteMigrations`. */
const localMigrationsFile = (): SiteFile => ({
  path: "lib/local-migrations.ts",
  content: `import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import { client, isPreviewDatabase } from "@/lib/db";

// Applies db/migrations/ to the preview's local database: when the preview starts, and again
// whenever Locus adds a migration (app/api/locus/preview-migrations). Locus does this for the
// published site when it publishes, so this never touches a real database.
const DIR = ${JSON.stringify(SITE_MIGRATIONS_DIR)};
const LEDGER = ${JSON.stringify(SITE_MIGRATIONS_TABLE)};
const BREAKPOINT = ${JSON.stringify(STATEMENT_BREAKPOINT)};

export async function applyLocalMigrations() {
  if (!isPreviewDatabase) return { applied: [] as string[] };
  await client.execute(
    \`create table if not exists \${LEDGER} (name text primary key, hash text not null, applied_at integer not null)\`,
  );
  const done = new Map(
    (await client.execute(\`select name, hash from \${LEDGER}\`)).rows.map((row) => [
      String(row.name),
      String(row.hash),
    ]),
  );
  // The same rules as Locus applies at publish, so the preview never accepts what publishing
  // would refuse.
  // Folders under db/migrations (such as drizzle-kit's meta/) aren't migrations.
  const entries = await readdir(DIR, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const numbers = new Set<string>();
  for (const file of files) {
    if (!/^\\d{4}_[a-z0-9_]+\\.sql$/.test(file)) {
      throw new Error(\`\${DIR}/\${file} isn't named like \${DIR}/0001_short_name.sql.\`);
    }
    if (numbers.has(file.slice(0, 4))) {
      throw new Error(\`Two migrations are numbered \${file.slice(0, 4)}.\`);
    }
    numbers.add(file.slice(0, 4));
  }
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(DIR, file), "utf8");
      return { name: file.slice(0, -4), sql, hash: createHash("sha256").update(sql).digest("hex") };
    }),
  );
  // A migration that ran here but is gone or different now (an earlier version of the site was
  // restored, say) means this database no longer matches the site. It only holds test data, so
  // it starts again. Publishing still refuses a migration changed after it ran on the live site.
  const current = new Map(migrations.map((m) => [m.name, m.hash]));
  if ([...done].some(([name, hash]) => current.get(name) !== hash)) {
    console.warn("The preview's database no longer matched db/migrations, so it started again.");
    await resetLocalDatabase();
    done.clear();
  }
  const applied: string[] = [];
  for (const { name, sql, hash } of migrations) {
    if (done.get(name) === hash) continue;
    const statements: InStatement[] = sql
      .split(BREAKPOINT)
      .map((s) => s.trim())
      .filter(Boolean);
    statements.push({
      sql: \`insert into \${LEDGER} (name, hash, applied_at) values (?, ?, ?)\`,
      args: [name, hash, Date.now()],
    });
    // migrate, not batch: it turns foreign keys off outside the transaction, so rebuilding a
    // table doesn't cascade-delete the rows that refer to it.
    try {
      await client.migrate(statements);
    } catch (error) {
      // The preview started applying them at the same time: what it applied is done.
      const now = await client.execute({ sql: \`select hash from \${LEDGER} where name = ?\`, args: [name] });
      if (now.rows[0]?.hash === hash) continue;
      throw error;
    }
    applied.push(name);
  }
  return { applied };
}

/** Drops every table in the preview's database, then makes the ledger again. */
async function resetLocalDatabase() {
  const tables = await client.execute(
    "select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%'",
  );
  // Virtual tables (full-text search) first: dropping one drops the tables it keeps itself.
  const names = tables.rows
    .map((row) => ({ name: String(row.name), virtual: /^create virtual/i.test(String(row.sql ?? "")) }))
    .sort((a, b) => Number(b.virtual) - Number(a.virtual))
    .map((t) => t.name);
  await client.migrate(names.map((name) => \`drop table if exists "\${name.replaceAll('"', '""')}"\`));
  await client.execute(
    \`create table if not exists \${LEDGER} (name text primary key, hash text not null, applied_at integer not null)\`,
  );
}
`,
});

const instrumentationFile = (): SiteFile => ({
  path: "instrumentation.ts",
  content: `// Runs once when the server starts. In the preview it brings the local database up to date.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { applyLocalMigrations } = await import("@/lib/local-migrations");
  await applyLocalMigrations();
}
`,
});

/** Lets Locus bring the preview's database up to date after the agent adds a migration. */
const previewMigrateRouteFile = (): SiteFile => ({
  path: "app/api/locus/preview-migrations/route.ts",
  content: `import { isPreviewDatabase } from "@/lib/db";
import { applyLocalMigrations } from "@/lib/local-migrations";

// Preview only: the published site answers 404 and never runs migrations itself.
export async function POST() {
  if (!isPreviewDatabase) return new Response(null, { status: 404 });
  try {
    return Response.json(await applyLocalMigrations());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 422 });
  }
}
`,
});

// The site's own logins: email and password, stored in the site's own database. Each new member
// is also sent to the client's HighLevel contacts (lib/members.ts).
const authContent = (
  withMembers: boolean,
  previewCookies = true,
) => `import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@/db/schema";
import { db, isPreviewDatabase } from "@/lib/db";
${withMembers ? 'import { memberSignedUp } from "@/lib/members";\n' : ""}
// The site's own logins: email and password, stored in the site's own database. Server code
// only. The published site's secret is set by Locus on its host; the preview uses a fixed one,
// which is fine because the preview's database is a throwaway file.${
  withMembers
    ? `
// Keep the databaseHooks: each new member becomes a contact in the client's HighLevel.`
    : ""
}
export const auth = betterAuth({
  secret:
    process.env.${SITE_DATABASE_ENV.authSecret} ??
    (isPreviewDatabase ? "locus-preview-only-not-a-secret-at-all" : undefined),
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },${
    previewCookies
      ? `
  // The preview runs inside Locus's editor, a frame on another site, where the browser only
  // keeps a login cookie that is SameSite=None, Secure and partitioned to that editor.
  ...(isPreviewDatabase
    ? { advanced: { defaultCookieAttributes: { sameSite: "none", secure: true, partitioned: true } } }
    : {}),`
      : ""
  }${
    withMembers
      ? `
  databaseHooks: { user: { create: { after: memberSignedUp } } },`
      : ""
  }
  telemetry: { enabled: false },
});
`;

const authFile = (): SiteFile => ({ path: "lib/auth.ts", content: authContent(true) });

const membersFile = (): SiteFile => ({
  path: "lib/members.ts",
  content: `import { locus } from "@/lib/locus";

// Server code only. Tells Locus about a member who just signed up, so they become a contact in
// the client's HighLevel sub-account (tagged "website form: sign-up"). The site proves it is the
// site with its key, set on its host when it is published. In the preview nothing is sent.
// A failure is logged and never stops the sign-up.

const api = locus.siteApi ? \`\${locus.siteApi}/members\` : null;
const key = process.env.${SITE_DATABASE_ENV.filesKey};

export async function memberSignedUp(
  user: { email: string; name?: string | null },
  context: { headers?: Headers | null } | null,
): Promise<void> {
  if (!api || !key) return;
  const visitorIp = context?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  try {
    const res = await fetch(\`\${api}/signup\`, {
      method: "POST",
      headers: {
        authorization: \`Bearer \${key}\`,
        "content-type": "application/json",
        ...(visitorIp ? { "x-locus-visitor-ip": visitorIp } : {}),
      },
      body: JSON.stringify({ email: user.email, ...(user.name ? { name: user.name } : {}) }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error(\`HighLevel didn't get a new member: \${res.status}\`);
  } catch {
    console.error("HighLevel didn't get a new member: Locus couldn't be reached");
  }
}
`,
});

/** lib/auth.ts as sites got it in earlier versions: replaced when unchanged. */
const EARLIER_AUTH = new Set([
  // before sign-ups went to HighLevel
  authContent(false, false),
  // before the preview's login cookie worked inside the editor
  authContent(true, false),
]);

const authRouteFile = (): SiteFile => ({
  path: "app/api/auth/[...all]/route.ts",
  content: `import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
`,
});

const authClientFile = (): SiteFile => ({
  path: "lib/auth-client.ts",
  content: `import { createAuthClient } from "better-auth/react";

// For "use client" components: authClient.signUp.email, signIn.email, signOut, useSession.
export const authClient = createAuthClient();
`,
});

// Files the site's members upload. The published site sends them to Locus, which keeps them in
// the client's own HighLevel Media Library; the site holds no HighLevel token and proves it is
// the site with SITE_FILES_KEY (set on its host when it is published). The preview keeps them in
// .data/files, and nothing leaves the sandbox. Files over 4 MB go from the member's browser
// straight to Locus's upload server with a one-time ticket, because the site's host takes at
// most 4.5 MB in a request; the preview takes them the ordinary way, up to 25 MB.
const LOCAL_FILES = ".data/files";

const filesFile = (): SiteFile => ({
  path: "lib/files.ts",
  content: `import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { locus } from "@/lib/locus";

// Server code only: never import this from a "use client" file. The app's own routes and
// server actions call these after checking the signed-in member; to keep a file, store its
// fileId and url in the app's own table with the member's user_id. A file's url opens it for
// anyone who has it, so show it only to whoever the app's records say may see it.

const api = locus.siteApi ? \`\${locus.siteApi}/files\` : null;
const key = process.env.${SITE_DATABASE_ENV.filesKey};
/** True in the preview (and a draft): files stay in ${LOCAL_FILES} and go nowhere. */
export const previewFiles = api === null;

/** What members may upload: the same kinds in the preview as on the published site. */
export const FILE_TYPES: readonly string[] = ${JSON.stringify(SITE_FILE_TYPES)};
export const VIDEO_TYPES: readonly string[] = ${JSON.stringify(SITE_VIDEO_TYPES)};
/** Sent through the site's own upload route. */
export const MAX_FILE_BYTES = ${MAX_SITE_FILE_BYTES};
/** Sent with a ticket (startBigUpload): other files, and videos. */
export const MAX_LARGE_FILE_BYTES = ${MAX_LARGE_SITE_FILE_BYTES};
export const MAX_VIDEO_BYTES = ${MAX_SITE_VIDEO_BYTES};
/** What the site's own upload route takes: more in the preview, which has no big uploads. */
export const MAX_ROUTE_BYTES = previewFiles ? MAX_LARGE_FILE_BYTES : MAX_FILE_BYTES;

export class FilesError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface KeptFile {
  fileId: string;
  url: string;
  name: string;
  contentType: string;
  size: number;
}

async function ask(path: string, init: RequestInit): Promise<Response> {
  if (!api || !key) throw new FilesError("File uploads aren't set up for this site yet.", 503);
  const res = await fetch(\`\${api}/\${path}\`, {
    ...init,
    headers: { ...init.headers, authorization: \`Bearer \${key}\` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new FilesError(body.error ?? "The file couldn't be handled just now.", res.status);
  }
  return res;
}

const PREVIEW_ID = /^[0-9a-f-]{36}$/;
const localPath = (fileId: string) =>
  PREVIEW_ID.test(fileId) ? join(${JSON.stringify(LOCAL_FILES)}, fileId) : null;

const mediaType = (type: string) => type.split(";")[0]?.trim().toLowerCase() ?? "";

/** Checks a file's kind and size, whatever the browser already checked. */
function checked(type: string, size: number, max: (video: boolean) => number): string {
  const contentType = mediaType(type);
  const video = VIDEO_TYPES.includes(contentType);
  if (!video && !FILE_TYPES.includes(contentType)) {
    throw new FilesError("That kind of file can't be uploaded here.", 415);
  }
  if (!Number.isInteger(size) || size < 1) throw new FilesError("That file is empty.");
  const most = max(video);
  if (size > most) throw new FilesError(\`Files like this can be up to \${most / 1024 / 1024} MB.\`, 413);
  return contentType;
}

/**
 * Keeps a file a member uploaded. \`visitorIp\` is the member's address from the host's
 * forwarding header, for Locus's per-visitor limit.
 */
export async function keepFile(file: File, visitorIp?: string | null): Promise<KeptFile> {
  const contentType = checked(file.type, file.size, () => MAX_ROUTE_BYTES);
  if (previewFiles) {
    const fileId = randomUUID();
    const name = file.name.replace(/[^\\w.-]+/g, "-").slice(-80).replace(/^[.-]+/, "") || "file";
    await mkdir(${JSON.stringify(LOCAL_FILES)}, { recursive: true });
    await writeFile(join(${JSON.stringify(LOCAL_FILES)}, fileId), new Uint8Array(await file.arrayBuffer()));
    await writeFile(join(${JSON.stringify(LOCAL_FILES)}, \`\${fileId}.json\`), JSON.stringify({ name, contentType }));
    return { fileId, url: \`/api/files/preview/\${fileId}\`, name, contentType, size: file.size };
  }
  const form = new FormData();
  form.set("file", file, file.name);
  const res = await ask("upload", {
    method: "POST",
    headers: visitorIp ? { "x-locus-visitor-ip": visitorIp } : {},
    body: form,
  });
  return (await res.json()) as KeptFile;
}

export type BigUpload =
  | { uploadUrl: string; ticket: string; contentType: string; expiresAt: number }
  | { uploadUrl: null; preview?: true };

/**
 * Starts an upload of a file over MAX_FILE_BYTES: the member's browser then PUTs the file to
 * \`uploadUrl\` with \`content-type: contentType\` and \`x-locus-ticket: ticket\`, once, within ten
 * minutes.
 * \`uploadUrl\` is null when this host can't take big files (\`preview\` when the preview takes
 * them through the site's own upload route instead).
 */
export async function startBigUpload(
  meta: { name: string; contentType: string; size: number },
  visitorIp?: string | null,
): Promise<BigUpload> {
  const contentType = checked(meta.contentType, meta.size, (video) =>
    previewFiles ? MAX_LARGE_FILE_BYTES : video ? MAX_VIDEO_BYTES : MAX_LARGE_FILE_BYTES,
  );
  if (previewFiles) return { uploadUrl: null, preview: true };
  const res = await ask("ticket", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(visitorIp ? { "x-locus-visitor-ip": visitorIp } : {}),
    },
    body: JSON.stringify({ name: meta.name.slice(0, 300), contentType, size: meta.size }),
  });
  return (await res.json()) as BigUpload;
}

/** The preview's stand-in for the Media Library: a file kept in ${LOCAL_FILES}, or null. */
export async function previewFileResponse(fileId: string): Promise<Response | null> {
  const path = previewFiles ? localPath(fileId) : null;
  if (!path) return null;
  const bytes = await readFile(path).catch(() => null);
  const meta = await readFile(\`\${path}.json\`, "utf8").then(JSON.parse, () => null);
  const known = meta && (FILE_TYPES.includes(meta.contentType) || VIDEO_TYPES.includes(meta.contentType));
  if (!bytes || !known) return null;
  const pdf = meta.contentType === "application/pdf";
  const shown = pdf || /^(image|video)\\//.test(meta.contentType);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": meta.contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      ...(pdf ? {} : { "content-security-policy": "sandbox; default-src 'none'" }),
      ...(shown ? {} : { "content-disposition": "attachment" }),
    },
  });
}

/** Deletes files the app checked the member may delete, by their fileId. */
export async function deleteFiles(fileIds: string[]) {
  if (fileIds.length === 0) return;
  if (previewFiles) {
    for (const fileId of fileIds) {
      const path = localPath(fileId);
      if (path) {
        await rm(path, { force: true });
        await rm(\`\${path}.json\`, { force: true });
      }
    }
    return;
  }
  await ask("delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileIds }),
  });
}
`,
});

const filesRouteFile = (): SiteFile => ({
  path: "app/api/files/upload/route.ts",
  content: `import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { FilesError, keepFile, MAX_ROUTE_BYTES } from "@/lib/files";

// Signed-in members only. POST a form with \`file\` → { fileId, url, name, contentType, size }.
// Save the fileId and url with the app's own record of who uploaded it.

const refused = (error: string, status: number) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const asked = await headers();
  if (!(await auth.api.getSession({ headers: asked }))) {
    return refused("Sign in to upload files.", 401);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_ROUTE_BYTES + 64 * 1024) {
    return refused(\`Files can be up to \${MAX_ROUTE_BYTES / 1024 / 1024} MB here.\`, 413);
  }
  const file = (await request.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) return refused("Send the file.", 400);
  try {
    const visitorIp = asked.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    return Response.json(await keepFile(file, visitorIp));
  } catch (error) {
    if (error instanceof FilesError) return refused(error.message, error.status);
    throw error;
  }
}
`,
});

const ticketRouteFile = (): SiteFile => ({
  path: "app/api/files/ticket/route.ts",
  content: `import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { FilesError, startBigUpload } from "@/lib/files";

// Signed-in members only. POST { name, contentType, size } for a file over 4 MB → where the
// browser sends it (see startBigUpload). lib/files-client.ts does all of this.

const refused = (error: string, status: number) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const asked = await headers();
  if (!(await auth.api.getSession({ headers: asked }))) {
    return refused("Sign in to upload files.", 401);
  }
  const text = await request.text();
  if (text.length > 4096) return refused("That's too much to send.", 413);
  let meta: { name?: unknown; contentType?: unknown; size?: unknown } | null;
  try {
    meta = JSON.parse(text);
  } catch {
    return refused("Send JSON.", 400);
  }
  if (!meta || typeof meta !== "object" || typeof meta.name !== "string" || typeof meta.contentType !== "string" || typeof meta.size !== "number") {
    return refused("Give the file's name, type and size.", 400);
  }
  try {
    const visitorIp = asked.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    return Response.json(
      await startBigUpload({ name: meta.name, contentType: meta.contentType, size: meta.size }, visitorIp),
    );
  } catch (error) {
    if (error instanceof FilesError) return refused(error.message, error.status);
    throw error;
  }
}
`,
});

const previewFilesRouteFile = (): SiteFile => ({
  path: "app/api/files/preview/[fileId]/route.ts",
  content: `import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { previewFileResponse } from "@/lib/files";

// The preview only: sends a file kept in the sandbox. A published site's files are opened from
// the url HighLevel gave them.

export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  if (!(await auth.api.getSession({ headers: await headers() }))) {
    return Response.json({ error: "Sign in to see this file." }, { status: 401 });
  }
  const sent = await previewFileResponse((await params).fileId);
  return sent ?? Response.json({ error: "There's no such file." }, { status: 404 });
}
`,
});

const filesClientFile = (): SiteFile => ({
  path: "lib/files-client.ts",
  content: `// For "use client" components: uploads a file the member picked and resolves to where it is
// kept. Save fileId and url with the app's own record; show the file from url. Files over 4 MB
// (and videos) go straight from the browser to Locus's upload server with a one-time ticket.

export interface UploadedFile {
  fileId: string;
  url: string;
  name: string;
  contentType: string;
  size: number;
}

const MAX_FILE_BYTES = ${MAX_SITE_FILE_BYTES};

async function kept(res: Response): Promise<UploadedFile> {
  const body = (await res.json().catch(() => ({}))) as Partial<UploadedFile> & { error?: string };
  if (!res.ok || !body.fileId) throw new Error(body.error ?? "The file couldn't be uploaded.");
  return body as UploadedFile;
}

function sendForm(file: File): Promise<Response> {
  const form = new FormData();
  form.set("file", file, file.name);
  return fetch("/api/files/upload", { method: "POST", body: form });
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  if (file.size <= MAX_FILE_BYTES) return kept(await sendForm(file));
  const res = await fetch("/api/files/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, contentType: file.type, size: file.size }),
  });
  const start = (await res.json().catch(() => ({}))) as {
    uploadUrl?: string | null;
    ticket?: string;
    contentType?: string;
    preview?: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(start.error ?? "The file couldn't be uploaded.");
  if (start.preview) return kept(await sendForm(file));
  if (!start.uploadUrl || !start.ticket || !start.contentType) {
    throw new Error(\`Files can be up to \${MAX_FILE_BYTES / 1024 / 1024} MB here.\`);
  }
  return kept(
    await fetch(start.uploadUrl, {
      method: "PUT",
      headers: { "content-type": start.contentType, "x-locus-ticket": start.ticket },
      body: file,
    }),
  );
}
`,
});

/** Files Locus keeps up to date on every `database add`: the site's skill says never edit them. */
const LOCUS_FILES = new Set([
  "lib/local-migrations.ts",
  "lib/members.ts",
  "lib/files.ts",
  "lib/files-client.ts",
  "app/api/files/upload/route.ts",
  "app/api/files/ticket/route.ts",
  "app/api/files/preview/[fileId]/route.ts",
]);
const RETIRED_FILES = ["app/api/files/[action]/route.ts"];

/** The files an app-style site adds. */
export function backendFiles(): SiteFile[] {
  return [
    schemaFile(),
    { path: FIRST_MIGRATION_PATH, content: `${LOGINS_MIGRATION}\n` },
    dbFile(),
    localMigrationsFile(),
    instrumentationFile(),
    previewMigrateRouteFile(),
    authFile(),
    membersFile(),
    authRouteFile(),
    authClientFile(),
    filesFile(),
    filesRouteFile(),
    ticketRouteFile(),
    previewFilesRouteFile(),
    filesClientFile(),
  ];
}

/** Whether a site's files already include its database (it has `db/schema.ts`). */
export function hasBackendFiles(files: SiteFile[]): boolean {
  return files.some((file) => file.path === SITE_SCHEMA_PATH);
}

/**
 * Turns a site's files into an app-style site's. Safe to repeat: files the site already has
 * are kept as they are, so a schema the agent has grown is never reset.
 */
/** The site's name as an older lib/locus.ts wrote it, or "". */
function siteNameIn(settings: string): string {
  const quoted = /site:\s*\{\s*"?name"?:\s*("(?:[^"\\]|\\.)*")/.exec(settings)?.[1];
  if (!quoted) return "";
  try {
    const name: unknown = JSON.parse(quoted);
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

export function withBackend(files: SiteFile[]): SiteFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const pkg = byPath.get("package.json");
  if (pkg && typeof pkg.content === "string") {
    const json = JSON.parse(pkg.content) as { dependencies?: Record<string, string> };
    // Packages the site already has keep their versions.
    json.dependencies = { ...BACKEND_STACK, ...json.dependencies };
    json.dependencies = Object.fromEntries(
      Object.entries(json.dependencies).sort(([a], [b]) => a.localeCompare(b)),
    );
    byPath.set("package.json", {
      path: "package.json",
      content: `${JSON.stringify(json, null, 2)}\n`,
    });
  }
  const ignore = byPath.get(".gitignore");
  if (ignore && typeof ignore.content === "string" && !/^\.data\/$/m.test(ignore.content)) {
    byPath.set(".gitignore", { path: ".gitignore", content: `${ignore.content}.data/\n` });
  }
  // Files from an earlier version of the uploads, replaced by the current ones.
  for (const path of RETIRED_FILES) byPath.delete(path);
  // A login file nobody has changed since an earlier version gets the current one; one the
  // agent changed is kept, and the site's skill says how to add the hook by hand.
  const auth = byPath.get("lib/auth.ts")?.content;
  if (typeof auth === "string" && EARLIER_AUTH.has(auth)) byPath.delete("lib/auth.ts");
  for (const file of backendFiles()) {
    if (!byPath.has(file.path) || LOCUS_FILES.has(file.path)) byPath.set(file.path, file);
  }
  // lib/members.ts and lib/files.ts read `locus.siteApi`, which a site made before Locus had
  // site calls lacks; it would stop at type-checking. Outside a published site its values are
  // null but the site's name, and publishing writes it again, so the draft's copy is replaced
  // keeping that name.
  const settings = byPath.get(LOCUS_SETTINGS_PATH)?.content;
  if (typeof settings !== "string" || !settings.includes("siteApi")) {
    const name = typeof settings === "string" ? siteNameIn(settings) : "";
    byPath.set(LOCUS_SETTINGS_PATH, locusSettingsFile({ site: { name, description: "" } }));
  }
  return [...byPath.values()];
}
