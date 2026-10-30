import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { ghlHeldInstall } from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgencyGrant } from "./ghl-oauth.ts";
import {
  dropHeldGrant,
  HELD_GRANT_MS,
  holdGrant,
  peekHeldGrant,
  takeHeldGrant,
} from "./held-grant.ts";

const grant: AgencyGrant = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 0,
  scopes: "locations.readonly",
  companyId: "co_1",
  installedBy: "u_1",
};

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let now: number;
const deps = () => ({ db, secrets, now: () => now });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-held-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  now = 1_000_000;
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("held marketplace grants", () => {
  it("holds a grant until it is taken, once", async () => {
    const id = await holdGrant(deps(), grant);
    expect(await peekHeldGrant(deps(), id)).toEqual(grant);
    now += HELD_GRANT_MS - 1;
    expect(await takeHeldGrant(deps(), id)).toEqual(grant);
    expect(await takeHeldGrant(deps(), id)).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it("gives a grant to only one of two racing takes", async () => {
    const id = await holdGrant(deps(), grant);
    const both = await Promise.all([takeHeldGrant(deps(), id), takeHeldGrant(deps(), id)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a grant past its hour, and sweeps it when the next one is held", async () => {
    const old = await holdGrant(deps(), grant);
    now += HELD_GRANT_MS;
    expect(await peekHeldGrant(deps(), old)).toBeNull();
    expect(await takeHeldGrant(deps(), old)).toBeNull();
    const fresh = await holdGrant(deps(), grant);
    expect([...secrets.values.keys()]).toEqual([`/locus/ghl-held/${fresh}`]);
    expect(await db.select().from(ghlHeldInstall)).toHaveLength(1);
  });

  it("drops a grant without using it", async () => {
    const id = await holdGrant(deps(), grant);
    await dropHeldGrant(deps(), id);
    expect(await peekHeldGrant(deps(), id)).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it("ignores missing and malformed ids", async () => {
    expect(await peekHeldGrant(deps(), undefined)).toBeNull();
    expect(await takeHeldGrant(deps(), "../ghl/org")).toBeNull();
  });
});
