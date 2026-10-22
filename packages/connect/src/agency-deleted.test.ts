import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { agencyGhlConnection, hostConnection, organization } from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import { deleteAgencySecrets } from "./agency-deleted.ts";
import { vercelSecretRef } from "./vercel.ts";

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
const now = new Date();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-agency-deleted-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  for (const id of ["agency-a", "agency-ab"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("deleting an agency's sealed credentials", () => {
  it("removes its GHL and Vercel tokens and leaves other agencies' alone", async () => {
    // "agency-ab" starts with "agency-a": paths are matched whole, never by prefix.
    for (const agency of ["agency-a", "agency-ab"]) {
      await secrets.set(ghlSecretRef(agency), `ghl-${agency}`);
      await secrets.set(vercelSecretRef(agency), `vercel-${agency}`);
    }

    await deleteAgencySecrets({ db, secrets }, "agency-a");

    expect(await secrets.get(ghlSecretRef("agency-a"))).toBeUndefined();
    expect(await secrets.get(vercelSecretRef("agency-a"))).toBeUndefined();
    expect(await secrets.get(ghlSecretRef("agency-ab"))).toBe("ghl-agency-ab");
    expect(await secrets.get(vercelSecretRef("agency-ab"))).toBe("vercel-agency-ab");
  });

  it("also removes the paths its connection rows name", async () => {
    await db.insert(agencyGhlConnection).values({
      organizationId: "agency-a",
      ghlCompanyId: "company-a",
      scopes: "",
      secretRef: "/locus/ghl-old/agency-a",
      connectedAt: now,
    });
    await db.insert(hostConnection).values({
      organizationId: "agency-a",
      provider: "netlify",
      teamId: "team-a",
      secretRef: "/locus/netlify/agency-a",
      connectedAt: now,
    });
    await secrets.set("/locus/ghl-old/agency-a", "ghl");
    await secrets.set("/locus/netlify/agency-a", "netlify");

    await deleteAgencySecrets({ db, secrets }, "agency-a");

    expect(await secrets.get("/locus/ghl-old/agency-a")).toBeUndefined();
    expect(await secrets.get("/locus/netlify/agency-a")).toBeUndefined();
  });

  it("is safe to run again, or for an agency that never connected anything", async () => {
    await expect(deleteAgencySecrets({ db, secrets }, "agency-a")).resolves.toBeUndefined();
    await expect(deleteAgencySecrets({ db, secrets }, "agency-a")).resolves.toBeUndefined();
  });
});
