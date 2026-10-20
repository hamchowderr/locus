import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    ]) {
      expect(app.map((f) => f.path)).toContain(path);
    }
    expect(withBackend(app)).toEqual(app);

    const grown = app.map((f) =>
      f.path === SITE_SCHEMA_PATH ? { ...f, content: `${f.content}// bookings\n` } : f,
    );
    expect(text(withBackend(grown), SITE_SCHEMA_PATH)).toContain("// bookings");
  });

  it("keeps every credential out of the site's files", () => {
    const all = withBackend(site())
      .map((f) => String(f.content))
      .join("\n");
    expect(all).not.toMatch(/libsql:\/\/|eyJ[a-zA-Z0-9_-]{10,}/);
    expect(text(withBackend(site()), "lib/db.ts")).toContain("process.env.SITE_DATABASE_TOKEN");
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
