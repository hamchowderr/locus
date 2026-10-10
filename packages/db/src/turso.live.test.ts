// Live: real Turso databases. Manual, never CI:
//   TURSO_ORG=… TURSO_GROUP=locus TURSO_API_TOKEN=… pnpm --filter @locus/db test:live
// (with the values from Infisical, e.g. `infisical run --path=/locus -- …`).
// Creates two throwaway databases, proves a token for one is refused by the other (Phase 0
// done-criterion 7), and deletes both, even on failure.
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { TursoProvisioner } from "./turso.ts";

const live = process.env.LOCUS_LIVE_TURSO === "1";

describe.skipIf(!live)("Turso, live", () => {
  const provisioner = live
    ? new TursoProvisioner({
        org: process.env.TURSO_ORG as string,
        group: process.env.TURSO_GROUP as string,
        apiToken: process.env.TURSO_API_TOKEN as string,
      })
    : (undefined as unknown as TursoProvisioner);
  const created: string[] = [];

  afterAll(async () => {
    for (const name of created) await provisioner.destroy(name);
  });

  it("isolates clients: a token for A is refused by B's database", async () => {
    const a = await provisioner.create(`live-test-${randomUUID().slice(0, 8)}`);
    created.push(a.dbName);
    const b = await provisioner.create(`live-test-${randomUUID().slice(0, 8)}`);
    created.push(b.dbName);

    const tokenA = await provisioner.mintToken(a.dbName, { ttl: "10m" });
    const own = createClient({ url: provisioner.url(a.hostname), authToken: tokenA });
    try {
      await own.execute("create table t (x integer)");
      await own.execute("insert into t values (1)");
      expect((await own.execute("select x from t")).rows).toHaveLength(1);
    } finally {
      own.close();
    }

    const other = createClient({ url: provisioner.url(b.hostname), authToken: tokenA });
    try {
      await expect(other.execute("select 1")).rejects.toThrow();
    } finally {
      other.close();
    }
  }, 60_000);
});
