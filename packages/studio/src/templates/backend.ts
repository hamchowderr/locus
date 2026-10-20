import {
  SITE_DATABASE_ENV,
  SITE_MIGRATIONS_DIR,
  SITE_MIGRATIONS_TABLE,
  STATEMENT_BREAKPOINT,
} from "@locus/db";
import type { SiteFile } from "../workspace.ts";

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
  "@vercel/blob": "2.8.1",
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
  const applied: string[] = [];
  for (const file of files) {
    const name = file.slice(0, -4);
    const sql = await readFile(join(DIR, file), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const was = done.get(name);
    if (was === hash) continue;
    if (was) throw new Error(\`\${name} was changed after it ran. Add a new migration instead.\`);
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

const authFile = (): SiteFile => ({
  path: "lib/auth.ts",
  content: `import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@/db/schema";
import { db, isPreviewDatabase } from "@/lib/db";

// The site's own logins: email and password, stored in the site's own database. Server code
// only. The published site's secret is set by Locus on its host; the preview uses a fixed one,
// which is fine because the preview's database is a throwaway file.
export const auth = betterAuth({
  secret:
    process.env.${SITE_DATABASE_ENV.authSecret} ??
    (isPreviewDatabase ? "locus-preview-only-not-a-secret-at-all" : undefined),
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },
  telemetry: { enabled: false },
});
`,
});

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

// Files the site's members upload. The published site keeps them in Locus's file storage and
// holds no storage credential: its routes ask Locus, proving they are the site with
// SITE_FILES_KEY (set on its host when it is published), and the browser sends the file
// straight to storage with a one-file token Locus hands out. The preview keeps them in
// .data/files, and nothing leaves the sandbox.
const LOCAL_FILES = ".data/files";

const filesFile = (): SiteFile => ({
  path: "lib/files.ts",
  content: `import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { locus } from "@/lib/locus";

// Server code only: never import this from a "use client" file. The app's own routes and
// server actions call these after checking the signed-in member; to keep a file, store its
// pathname in the app's own table with the member's user_id.

const api = locus.siteApi ? \`\${locus.siteApi}/files\` : null;
const key = process.env.${SITE_DATABASE_ENV.filesKey};
/** True in the preview (and a draft): files stay in ${LOCAL_FILES} and go nowhere. */
export const previewFiles = api === null;

export class FilesError extends Error {}

async function ask(path: string, init: RequestInit = {}): Promise<Response> {
  if (!api || !key) throw new FilesError("File uploads aren't set up for this site yet.");
  const res = await fetch(\`\${api}/\${path}\`, {
    ...init,
    headers: { ...init.headers, authorization: \`Bearer \${key}\` },
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new FilesError(body.error ?? "The file couldn't be handled just now.");
  }
  return res;
}

const localPath = (pathname: string) => {
  if (!/^sites\\/preview\\/[\\w-]+\\/[\\w.-]+$/.test(pathname)) return null;
  return join(${JSON.stringify(LOCAL_FILES)}, pathname);
};

/** Starts an upload: where the file will be, and the token the browser sends it with. */
export async function startUpload(file: { name: string; contentType: string; size: number }) {
  if (previewFiles) {
    const name = file.name.replace(/[^\\w.-]+/g, "-").replace(/^[.-]+/, "").slice(-80) || "file";
    return { pathname: \`sites/preview/\${randomUUID()}/\${name}\`, token: null };
  }
  const res = await ask("upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(file),
  });
  return (await res.json()) as { pathname: string; token: string };
}

/** The preview's stand-in for storage: keeps an uploaded file in ${LOCAL_FILES}. */
export async function savePreviewFile(pathname: string, bytes: ArrayBuffer) {
  const path = previewFiles ? localPath(pathname) : null;
  if (!path) throw new FilesError("That isn't a file this preview can keep.");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(bytes));
}

/** A file, as a response to send the member, or null when there is none. */
export async function fileResponse(pathname: string): Promise<Response | null> {
  if (previewFiles) {
    const path = localPath(pathname);
    const bytes = path ? await readFile(path).catch(() => null) : null;
    return bytes ? new Response(new Uint8Array(bytes)) : null;
  }
  const res = await ask(\`read?pathname=\${encodeURIComponent(pathname)}\`);
  if (res.status === 404) return null;
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Deletes files the app checked the member may delete. */
export async function deleteFiles(pathnames: string[]) {
  if (pathnames.length === 0) return;
  if (previewFiles) {
    for (const pathname of pathnames) {
      const path = localPath(pathname);
      if (path) await rm(path, { force: true });
    }
    return;
  }
  await ask("delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathnames }),
  });
}
`,
});

const filesRouteFile = (): SiteFile => ({
  path: "app/api/files/[action]/route.ts",
  content: `import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { FilesError, fileResponse, savePreviewFile, startUpload } from "@/lib/files";

// Signed-in members only. POST upload { name, contentType, size } → { pathname, token };
// PUT preview?pathname=… (the preview only) keeps the file; GET read?pathname=… sends it.
// Anyone signed in who knows a file's pathname can read it: pathnames are random, but show a
// file only to whoever the app's own records say may see it.

type Params = { params: Promise<{ action: string }> };

async function member() {
  return auth.api.getSession({ headers: await headers() });
}

const refused = (error: string, status: number) => Response.json({ error }, { status });

export async function POST(request: Request, { params }: Params) {
  if ((await params).action !== "upload") return refused("Not found.", 404);
  if (!(await member())) return refused("Sign in to upload files.", 401);
  const file = (await request.json().catch(() => null)) as {
    name?: unknown;
    contentType?: unknown;
    size?: unknown;
  } | null;
  if (typeof file?.name !== "string" || typeof file.contentType !== "string" || typeof file.size !== "number") {
    return refused("Give the file's name, type and size.", 400);
  }
  try {
    return Response.json(
      await startUpload({ name: file.name, contentType: file.contentType, size: file.size }),
    );
  } catch (error) {
    if (error instanceof FilesError) return refused(error.message, 400);
    throw error;
  }
}

export async function PUT(request: Request, { params }: Params) {
  if ((await params).action !== "preview") return refused("Not found.", 404);
  if (!(await member())) return refused("Sign in to upload files.", 401);
  const pathname = new URL(request.url).searchParams.get("pathname") ?? "";
  try {
    await savePreviewFile(pathname, await request.arrayBuffer());
    return Response.json({ pathname });
  } catch (error) {
    if (error instanceof FilesError) return refused(error.message, 400);
    throw error;
  }
}

export async function GET(request: Request, { params }: Params) {
  if ((await params).action !== "read") return refused("Not found.", 404);
  if (!(await member())) return refused("Sign in to see this file.", 401);
  const pathname = new URL(request.url).searchParams.get("pathname") ?? "";
  try {
    return (await fileResponse(pathname)) ?? refused("There's no such file.", 404);
  } catch (error) {
    if (error instanceof FilesError) return refused(error.message, 400);
    throw error;
  }
}
`,
});

const filesClientFile = (): SiteFile => ({
  path: "lib/files-client.ts",
  content: `import { put } from "@vercel/blob/client";

// For "use client" components. uploadFile sends a file the member picked and resolves to its
// pathname; save that with the app's own record. fileUrl is where the page shows it from.

export async function uploadFile(file: File): Promise<{ pathname: string }> {
  const res = await fetch("/api/files/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, contentType: file.type, size: file.size }),
  });
  const start = (await res.json()) as { pathname?: string; token?: string | null; error?: string };
  if (!res.ok || !start.pathname) throw new Error(start.error ?? "The file couldn't be uploaded.");
  if (start.token) {
    await put(start.pathname, file, {
      access: "private",
      token: start.token,
      contentType: file.type,
      multipart: file.size > 5 * 1024 * 1024,
    });
  } else {
    const saved = await fetch(\`/api/files/preview?pathname=\${encodeURIComponent(start.pathname)}\`, {
      method: "PUT",
      body: file,
    });
    if (!saved.ok) throw new Error("The file couldn't be uploaded.");
  }
  return { pathname: start.pathname };
}

export const fileUrl = (pathname: string) =>
  \`/api/files/read?pathname=\${encodeURIComponent(pathname)}\`;
`,
});

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
    authRouteFile(),
    authClientFile(),
    filesFile(),
    filesRouteFile(),
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
  for (const file of backendFiles()) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}
