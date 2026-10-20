import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, type SessionContext } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import { member, organization, site, user } from "@locus/db/control";
import { FakeRuntimeProvider } from "@locus/sandbox";
import { readBrief, SiteWorkspace } from "@locus/studio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeClientDbs,
  createClientSite,
  openClientDb,
  type SiteBuilderDeps,
  SiteInputError,
} from "./site-builder.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let runtimes: FakeRuntimeProvider;
let clientA: string;
const now = new Date();

const ctx = (userId: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId: "agency-a",
});

const deps = (): SiteBuilderDeps => ({
  db,
  openClientDb: (client) => openClientDb(provisioner, client),
  runtimes: () => runtimes,
  images: null,
  publish: null,
  locusUrl: "https://locus.test",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-start-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "tenants"));
  runtimes = new FakeRuntimeProvider();
  await db.insert(organization).values({ id: "agency-a", name: "A", slug: "a", createdAt: now });
  await db
    .insert(user)
    .values({ id: "staff", name: "staff", email: "staff@agency.test", emailVerified: true });
  await db.insert(member).values({
    id: "staff@agency-a",
    userId: "staff",
    organizationId: "agency-a",
    role: "owner",
    createdAt: now,
  });
  const control = { control: db, provisioner };
  clientA = (
    await provisionLocation(control, { organizationId: "agency-a", ghlLocationId: "ga", name: "A" })
  ).id;
});

afterEach(async () => {
  closeClientDbs();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const authorized = (locationId: string) => authorizeClient(db, ctx("staff"), locationId);

describe("starting a site from design answers", () => {
  it("puts the answers in the brief and the screenshot in version 1", async () => {
    const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const client = await authorized(clientA);
    const { siteId } = await createClientSite(deps(), ctx("staff"), client, {
      name: "Bright Smiles",
      kind: "website",
      goal: "Book an appointment",
      palette: "Soft pastels",
      referenceUrl: "https://brightsmiles.example",
      screenshot: { bytes: PNG, mediaType: "image/png" },
    });
    const tenant = await openClientDb(provisioner, client);
    const workspace = new SiteWorkspace(tenant, siteId);
    expect(await readBrief(tenant, siteId)).toMatchObject({
      goal: "Book an appointment",
      palette: { primary: "#7c3aed" },
      references: [
        { kind: "url", url: "https://brightsmiles.example/" },
        { kind: "screenshot", path: "design/references/screenshot-1.png" },
      ],
    });
    const [v1] = await workspace.listVersions();
    const files = await workspace.versionFiles(v1?.id ?? "");
    expect(files.find((f) => f.path === "design/references/screenshot-1.png")?.content).toEqual(
      PNG,
    );
    // The chosen colours are in the template's theme from the start.
    expect(String(files.find((f) => f.path === "app/globals.css")?.content)).toContain("#7c3aed");
    tenant.$client.close();
  });

  it("refuses a bad answer and leaves no site behind", async () => {
    const client = await authorized(clientA);
    await expect(
      createClientSite(deps(), ctx("staff"), client, {
        name: "X",
        kind: "website",
        screenshot: { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      }),
    ).rejects.toBeInstanceOf(SiteInputError);
    expect(await db.select().from(site)).toEqual([]);
  });
});
