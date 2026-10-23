import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import {
  agencyGhlConnection,
  hostConnection,
  location,
  organization,
  site,
  siteBackend,
} from "@locus/db/control";
import { MemorySecretStore } from "@locus/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import { deleteAgencySecrets, offboardAgencyClients } from "./agency-deleted.ts";
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

describe("removing a deleted agency's clients", () => {
  it("disconnects each client's apps and deletes its database, and leaves other agencies' alone", async () => {
    const provisioner = new LocalProvisioner(join(dir, "tenants"));
    const deps = { control: db, provisioner, migrations: [] };
    const mine = await provisionLocation(deps, {
      organizationId: "agency-a",
      ghlLocationId: "loc-a",
      name: "A",
    });
    const theirs = await provisionLocation(deps, {
      organizationId: "agency-ab",
      ghlLocationId: "loc-ab",
      name: "AB",
    });
    // An app-style site's database: its row restricts the client's deletion until it's gone.
    const backend = await provisioner.createDatabase("site-a");
    await db.insert(site).values({ id: "site-a", locationId: mine.id });
    await db.insert(siteBackend).values({
      siteId: "site-a",
      locationId: mine.id,
      tursoDbName: backend.dbName,
      tursoDbHostname: backend.hostname,
    });
    const disconnected: string[] = [];
    const destroyed: string[] = [];
    const watched = Object.assign(Object.create(provisioner), {
      destroy: async (name: string) => {
        destroyed.push(name);
        await provisioner.destroy(name);
      },
    }) as LocalProvisioner;

    await offboardAgencyClients(
      { db, provisioner: () => watched, disconnectApps: async (id) => void disconnected.push(id) },
      "agency-a",
    );

    expect(disconnected).toEqual([mine.id]);
    expect(destroyed).toEqual([backend.dbName, mine.dbName]);
    expect(await db.select().from(site)).toEqual([]);
    expect((await db.select().from(location)).map((row) => row.id)).toEqual([theirs.id]);
  });

  it("stops at a client whose apps can't be disconnected, so a retry finishes it", async () => {
    const provisioner = new LocalProvisioner(join(dir, "tenants"));
    await provisionLocation(
      { control: db, provisioner, migrations: [] },
      { organizationId: "agency-a", ghlLocationId: "loc-a", name: "A" },
    );
    const failing = async () => {
      throw new Error("Composio is down");
    };

    await expect(
      offboardAgencyClients(
        { db, provisioner: () => provisioner, disconnectApps: failing },
        "agency-a",
      ),
    ).rejects.toThrow("Composio is down");
    expect(await db.select().from(location)).toHaveLength(1);

    await offboardAgencyClients({ db, provisioner: () => provisioner }, "agency-a");
    expect(await db.select().from(location)).toEqual([]);
  });

  it("needs no database service for an agency with no clients", async () => {
    await offboardAgencyClients(
      {
        db,
        provisioner: () => {
          throw new Error("not configured");
        },
      },
      "agency-a",
    );
  });
});
