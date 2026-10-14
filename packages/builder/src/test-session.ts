import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTenantDb, TENANT_MIGRATION_SET, type TenantDb } from "@locus/db";
import { type FakeRuntimeOptions, FakeRuntimeProvider } from "@locus/sandbox";
import { SiteWorkspace } from "@locus/studio";
import type { ImageGenerator } from "./images.ts";
import type { BuilderSession, BuilderUsage, UsageMeter } from "./session.ts";

export interface TestSession {
  db: TenantDb;
  session: BuilderSession;
  runtimes: FakeRuntimeProvider;
  usage: BuilderUsage[];
  meter: UsageMeter & { refuse: string | null };
  close: () => Promise<void>;
}

/** A builder session on a fresh client database, a fake sandbox and a recording meter. */
export async function testSession(
  options: { runtime?: FakeRuntimeOptions; images?: ImageGenerator | null; siteId?: string } = {},
): Promise<TestSession> {
  const dir = await mkdtemp(join(tmpdir(), "locus-builder-"));
  const db = openTenantDb(`file:${join(dir, "tenant.db")}`);
  for (const migration of TENANT_MIGRATION_SET) {
    for (const statement of migration.sql) await db.$client.execute(statement);
  }
  const siteId = options.siteId ?? "site-1";
  const runtimes = new FakeRuntimeProvider(options.runtime);
  const usage: BuilderUsage[] = [];
  const meter = {
    refuse: null as string | null,
    async check() {
      return meter.refuse ? { ok: false as const, reason: meter.refuse } : { ok: true as const };
    },
    async record(u: BuilderUsage) {
      usage.push(u);
    },
  };
  const session: BuilderSession = {
    workspace: new SiteWorkspace(db, siteId),
    runtime: () => runtimes.open(siteId),
    images: options.images ?? null,
    meter,
    userId: "user-1",
  };
  return {
    db,
    session,
    runtimes,
    usage,
    meter,
    close: async () => {
      db.$client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
