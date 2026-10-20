import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createClient } from "@libsql/client";
import {
  applySiteMigrations,
  listSiteUsers,
  SITE_MIGRATIONS_TABLE,
  STATEMENT_BREAKPOINT,
  siteMigrationsIn,
} from "@locus/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignBrief } from "./brief.ts";
import {
  BACKEND_STACK,
  FIRST_MIGRATION_PATH,
  hasBackendFiles,
  renderTemplate,
  SITE_SCHEMA_PATH,
  templateById,
  withBackend,
} from "./templates/index.ts";
import type { SiteFile } from "./workspace.ts";

const brief = DesignBrief.parse({ name: "Members Club", kind: "website" });
// biome-ignore lint/style/noNonNullAssertion: "blank" is always a template
const site = () => renderTemplate(templateById("blank")!, brief);
const text = (files: SiteFile[], path: string) => {
  const file = files.find((f) => f.path === path);
  if (typeof file?.content !== "string") throw new Error(`no ${path}`);
  return file.content;
};

let dir: string;
let schemaFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-backend-"));
  // Next to this test, so the schema's own imports resolve to the workspace's drizzle-orm.
  schemaFile = join(import.meta.dirname, `.site-schema-${Date.now()}.ts`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(schemaFile, { force: true });
});

describe("an app-style site's files", () => {
  it("adds its database and logins to a site, once, without resetting its schema", () => {
    const plain = site();
    expect(hasBackendFiles(plain)).toBe(false);
    const app = withBackend(plain);
    expect(hasBackendFiles(app)).toBe(true);

    const pkg = JSON.parse(text(app, "package.json"));
    expect(pkg.dependencies).toMatchObject(BACKEND_STACK);
    expect(pkg.dependencies.next).toBeDefined();
    expect(text(app, ".gitignore")).toMatch(/^\.data\/$/m);
    for (const path of [
      SITE_SCHEMA_PATH,
      FIRST_MIGRATION_PATH,
      "lib/db.ts",
      "lib/auth.ts",
      "lib/auth-client.ts",
      "lib/local-migrations.ts",
      "instrumentation.ts",
      "app/api/auth/[...all]/route.ts",
      "lib/files.ts",
      "lib/files-client.ts",
      "app/api/files/upload/route.ts",
      "app/api/files/ticket/route.ts",
      "app/api/files/preview/[fileId]/route.ts",
    ]) {
      expect(app.map((f) => f.path)).toContain(path);
    }
    expect(withBackend(app)).toEqual(app);

    // An older version of the uploads is replaced; Locus's own file code is kept current.
    const older = [
      ...app.map((f) => (f.path === "lib/files.ts" ? { ...f, content: "// old" } : f)),
      { path: "app/api/files/[action]/route.ts", content: "// old" },
    ];
    const renewed = withBackend(older);
    expect(text(renewed, "lib/files.ts")).toContain("keepFile");
    expect(renewed.map((f) => f.path)).not.toContain("app/api/files/[action]/route.ts");

    const grown = app.map((f) =>
      f.path === SITE_SCHEMA_PATH ? { ...f, content: `${f.content}// bookings\n` } : f,
    );
    expect(text(withBackend(grown), SITE_SCHEMA_PATH)).toContain("// bookings");

    const pinned = app.map((f) =>
      f.path === "package.json"
        ? {
            ...f,
            content: JSON.stringify({
              dependencies: { ...pkg.dependencies, "drizzle-orm": "9.9.9" },
            }),
          }
        : f,
    );
    expect(JSON.parse(text(withBackend(pinned), "package.json")).dependencies["drizzle-orm"]).toBe(
      "9.9.9",
    );
  });

  it("keeps every credential out of the site's files", () => {
    const all = withBackend(site())
      .map((f) => String(f.content))
      .join("\n");
    expect(all).not.toMatch(/libsql:\/\/|eyJ[a-zA-Z0-9_-]{10,}/);
    expect(text(withBackend(site()), "lib/db.ts")).toContain("process.env.SITE_DATABASE_TOKEN");
    expect(text(withBackend(site()), "lib/files.ts")).toContain("process.env.SITE_FILES_KEY");
  });

  it("runs the preview's migrations with the same ledger as Locus", () => {
    const runner = text(withBackend(site()), "lib/local-migrations.ts");
    expect(runner).toContain(JSON.stringify(SITE_MIGRATIONS_TABLE));
    expect(runner).toContain(JSON.stringify(STATEMENT_BREAKPOINT));
    expect(runner).toContain('createHash("sha256")');
  });

  it("signs people up with Better Auth on a database built from its migration", async () => {
    const app = withBackend(site());
    const client = createClient({ url: `file:${join(dir, "site.db")}` });
    try {
      expect(await applySiteMigrations(client, siteMigrationsIn(app))).toEqual({
        applied: ["0000_logins"],
      });
      await writeFile(schemaFile, text(app, SITE_SCHEMA_PATH));
      const schema = await import(schemaFile);
      const auth = betterAuth({
        secret: "test-secret-test-secret-test-secret",
        baseURL: "http://site.test",
        database: drizzleAdapter(drizzle(client, { schema }), { provider: "sqlite", schema }),
        emailAndPassword: { enabled: true },
        telemetry: { enabled: false },
      });
      await auth.api.signUpEmail({
        body: { name: "Ann", email: "ann@example.test", password: "correct horse battery" },
      });
      const signedIn = await auth.api.signInEmail({
        body: { email: "ann@example.test", password: "correct horse battery" },
      });
      expect(signedIn.user.email).toBe("ann@example.test");
      await expect(
        auth.api.signInEmail({ body: { email: "ann@example.test", password: "wrong password" } }),
      ).rejects.toThrow();

      const users = await listSiteUsers(client);
      expect(users).toEqual([
        expect.objectContaining({ name: "Ann", email: "ann@example.test", emailVerified: false }),
      ]);
      expect(users[0]?.createdAt).toBeInstanceOf(Date);
    } finally {
      client.close();
    }
  });
});

/**
 * Writes the site's server files to a folder next to this test (so their imports resolve to
 * the workspace's packages), with the `@/` alias turned into relative paths.
 */
async function writeSite(files: SiteFile[], root: string) {
  for (const file of files) {
    if (!/\.(ts|sql)$/.test(file.path) || file.path.startsWith("app/")) continue;
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    const content = String(file.content).replace(/from "@\/([^"]+)"/g, (_, path: string) => {
      const to = relative(dirname(target), join(root, path)).replaceAll("\\", "/");
      return `from "${to.startsWith(".") ? to : `./${to}`}.ts"`;
    });
    await writeFile(target, content);
  }
}

describe("the generated preview database", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    root = join(import.meta.dirname, `.site-${Date.now()}`);
    cwd = process.cwd();
    await writeSite(withBackend(site()), root);
    process.chdir(root);
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("starts on a fresh sandbox, applies migrations once, and keeps rows through a rebuild", async () => {
    const { applyLocalMigrations } = await import(join(root, "lib/local-migrations.ts"));
    const { client } = await import(join(root, "lib/db.ts"));
    try {
      expect(await applyLocalMigrations()).toEqual({ applied: ["0000_logins"] });
      expect(await applyLocalMigrations()).toEqual({ applied: [] });
      await client.execute(
        `insert into "user" (id, name, email) values ('u1', 'Ann', 'ann@example.test')`,
      );
      await client.execute(
        `insert into "session" (id, expires_at, token, user_id) values ('s1', 1, 't', 'u1')`,
      );

      // A drizzle-kit style table rebuild of "user", which "session" refers to.
      await writeFile(
        "db/migrations/0001_rebuild_user.sql",
        [
          "PRAGMA foreign_keys=OFF;",
          "CREATE TABLE `__new_user` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `email` text NOT NULL, `email_verified` integer DEFAULT false NOT NULL, `image` text, `nickname` text, `created_at` integer DEFAULT 0 NOT NULL, `updated_at` integer DEFAULT 0 NOT NULL);",
          "INSERT INTO `__new_user`(`id`, `name`, `email`) SELECT `id`, `name`, `email` FROM `user`;",
          "DROP TABLE `user`;",
          "ALTER TABLE `__new_user` RENAME TO `user`;",
          "PRAGMA foreign_keys=ON;",
        ].join(`\n${STATEMENT_BREAKPOINT}\n`),
      );
      expect(await applyLocalMigrations()).toEqual({ applied: ["0001_rebuild_user"] });
      const sessions = await client.execute(`select count(*) as n from "session"`);
      expect(Number(sessions.rows[0]?.n)).toBe(1);

      await writeFile("db/migrations/0001_again.sql", "select 1;");
      await expect(applyLocalMigrations()).rejects.toThrow(/numbered 0001/);
      await rm("db/migrations/0001_again.sql");
      await writeFile("db/migrations/2_bad.sql", "select 1;");
      await expect(applyLocalMigrations()).rejects.toThrow(/isn't named like/);
    } finally {
      client.close();
    }
  });

  it("applies migrations once when two runs start together, and skips folders", async () => {
    await mkdir("db/migrations/meta", { recursive: true });
    await writeFile("db/migrations/meta/_journal.json", "{}");
    const { applyLocalMigrations } = await import(join(root, "lib/local-migrations.ts"));
    const { client } = await import(join(root, "lib/db.ts"));
    try {
      const runs = await Promise.all([applyLocalMigrations(), applyLocalMigrations()]);
      expect(runs.flatMap((run) => run.applied)).toContain("0000_logins");
      const ledger = await client.execute(`select count(*) as n from ${SITE_MIGRATIONS_TABLE}`);
      expect(Number(ledger.rows[0]?.n)).toBe(1);
    } finally {
      client.close();
    }
  });

  it("keeps the preview's uploads in the sandbox, taking what a published site takes", async () => {
    const files = await import(join(root, "lib/files.ts"));
    expect(files.previewFiles).toBe(true);
    const kept = await files.keepFile(new File(["png"], "../My photo.png", { type: "image/png" }));
    expect(kept).toMatchObject({ name: "My-photo.png", contentType: "image/png", size: 3 });
    expect(kept.url).toBe(`/api/files/preview/${kept.fileId}`);
    const sent = await files.previewFileResponse(kept.fileId);
    expect(await sent?.text()).toBe("png");
    expect(sent?.headers.get("content-type")).toBe("image/png");
    expect(sent?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await files.previewFileResponse("../package.json")).toBeNull();

    await expect(
      files.keepFile(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })),
    ).rejects.toThrow(/can't be uploaded/);
    await expect(
      files.keepFile(new File(["<script>"], "a.html", { type: "text/html" })),
    ).rejects.toThrow(/can't be uploaded/);
    // The preview has no upload server, so its own route takes files up to 25 MB.
    expect(files.MAX_ROUTE_BYTES).toBe(25 * 1024 * 1024);
    const big = await files.keepFile(
      new File([new Uint8Array(files.MAX_FILE_BYTES + 1)], "big.png", { type: "image/png" }),
    );
    expect(big.size).toBe(files.MAX_FILE_BYTES + 1);
    await expect(
      files.keepFile(
        new File([new Uint8Array(files.MAX_ROUTE_BYTES + 1)], "a.png", { type: "image/png" }),
      ),
    ).rejects.toThrow(/up to 25 MB/);
    const video = await files.keepFile(new File(["mp4"], "clip.mp4", { type: "video/mp4" }));
    const played = await files.previewFileResponse(video.fileId);
    expect(played?.headers.get("content-type")).toBe("video/mp4");
    expect(played?.headers.get("content-disposition")).toBeNull();
    await expect(
      files.startBigUpload({ name: "big.png", contentType: "image/png", size: 5_000_000 }),
    ).resolves.toEqual({ uploadUrl: null, preview: true });

    await files.deleteFiles([kept.fileId, big.fileId, video.fileId]);
    expect(await files.previewFileResponse(kept.fileId)).toBeNull();
  });

  it("asks Locus for a ticket for a published site's bigger files", async () => {
    await writeFile(
      join(root, "lib/locus.ts"),
      'export const locus = { siteApi: "https://locus.test/api/sites/s1" as string | null };\n',
    );
    vi.stubEnv("SITE_FILES_KEY", "files-key");
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({
        uploadUrl: "https://agent.test/site-files/upload",
        ticket: "t.mac",
        contentType: "video/mp4",
        expiresAt: 1,
      });
    });
    try {
      const files = await import(join(root, "lib/files.ts"));
      expect(files.previewFiles).toBe(false);
      expect(files.MAX_ROUTE_BYTES).toBe(4 * 1024 * 1024);
      const started = await files.startBigUpload(
        { name: "clip.mp4", contentType: "video/mp4; codecs=avc1", size: 100 * 1024 * 1024 },
        "203.0.113.9",
      );
      expect(started).toMatchObject({ uploadUrl: "https://agent.test/site-files/upload" });
      expect(sent[0]?.url).toBe("https://locus.test/api/sites/s1/files/ticket");
      const headers = sent[0]?.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer files-key");
      expect(headers["x-locus-visitor-ip"]).toBe("203.0.113.9");
      expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
        name: "clip.mp4",
        contentType: "video/mp4",
        size: 100 * 1024 * 1024,
      });
      // Checked here first: a video over 500 MB, or another file over 25 MB, never asks.
      await expect(
        files.startBigUpload({ name: "a.mp4", contentType: "video/mp4", size: 501 * 1024 * 1024 }),
      ).rejects.toThrow(/up to 500 MB/);
      await expect(
        files.startBigUpload({
          name: "a.pdf",
          contentType: "application/pdf",
          size: 26 * 1024 * 1024,
        }),
      ).rejects.toThrow(/up to 25 MB/);
      await expect(
        files.keepFile(
          new File([new Uint8Array(files.MAX_FILE_BYTES + 1)], "a.png", { type: "image/png" }),
        ),
      ).rejects.toThrow(/up to 4 MB/);
      expect(sent).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets a check build load the site without its database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("SITE_DATABASE_URL", "");
    const { client, isPreviewDatabase } = await import(join(root, "lib/db.ts"));
    try {
      expect(isPreviewDatabase).toBe(false);
      expect((await client.execute("select 1 as one")).rows[0]?.one).toBe(1);
    } finally {
      client.close();
    }
  });

  it("refuses to start a production server without its database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITE_DATABASE_URL", "");
    await expect(import(join(root, "lib/db.ts"))).rejects.toThrow(/SITE_DATABASE_URL is not set/);
  });
});
