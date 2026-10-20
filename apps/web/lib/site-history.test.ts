import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import { agencyComp, member, organization, usageEvent, user } from "@locus/db/control";
import { FakeRuntimeProvider } from "@locus/sandbox";
import { SiteWorkspace } from "@locus/studio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bookmarkSiteVersion,
  closeClientDbs,
  createClientSite,
  openClientDb,
  restoreSiteVersion,
  type SiteBuilderDeps,
  SiteInputError,
  siteHistory,
  siteRuntimeKey,
  startSitePreview,
  versionPreviewKey,
} from "./site-builder.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let runtimes: FakeRuntimeProvider;
let clientA: string;
let clientB: string;
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
  dir = await mkdtemp(join(tmpdir(), "locus-site-history-"));
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
  clientB = (
    await provisionLocation(control, { organizationId: "agency-a", ghlLocationId: "gb", name: "B" })
  ).id;
});

afterEach(async () => {
  closeClientDbs();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const authorized = (locationId: string) => authorizeClient(db, ctx("staff"), locationId);

/** A site at version 2, whose home page says "Two". */
async function siteWithTwoVersions(locationId = clientA) {
  const client = await authorized(locationId);
  const { siteId } = await createClientSite(deps(), ctx("staff"), client, {
    name: "Bright Smiles",
    kind: "website",
    templateId: "local-business",
  });
  const tenant = await openClientDb(provisioner, client);
  const workspace = new SiteWorkspace(tenant, siteId);
  await workspace.writeFile("app/page.tsx", "export default () => 'Two';");
  await workspace.saveVersion({ message: "Second", source: "agent" });
  return { client, siteId, tenant, workspace };
}

describe("a site's saved versions", () => {
  it("lists versions newest first and notices unsaved changes", async () => {
    const { client, siteId, tenant, workspace } = await siteWithTwoVersions();
    let history = await siteHistory(deps(), client, siteId);
    expect(history.versions.map((v) => [v.number, v.message])).toEqual([
      [2, "Second"],
      [1, "Started from the Local business template"],
    ]);
    expect(history).toMatchObject({ unsaved: false, more: 0 });

    await workspace.writeFile("app/page.tsx", "export default () => 'Draft';");
    history = await siteHistory(deps(), client, siteId);
    expect(history.unsaved).toBe(true);
    tenant.$client.close();
  });

  it("bookmarks a version and takes the bookmark off", async () => {
    const { client, siteId, tenant } = await siteWithTwoVersions();
    await bookmarkSiteVersion(deps(), client, siteId, { number: 1, bookmarked: true });
    let versions = (await siteHistory(deps(), client, siteId)).versions;
    expect(versions.map((v) => v.bookmarked)).toEqual([false, true]);
    await bookmarkSiteVersion(deps(), client, siteId, { number: 1, bookmarked: false });
    versions = (await siteHistory(deps(), client, siteId)).versions;
    expect(versions.map((v) => v.bookmarked)).toEqual([false, false]);
    await expect(
      bookmarkSiteVersion(deps(), client, siteId, { number: 9, bookmarked: true }),
    ).rejects.toBeInstanceOf(SiteInputError);
    tenant.$client.close();
  });

  it("restores a version as a new one and keeps unsaved changes first", async () => {
    const { client, siteId, tenant, workspace } = await siteWithTwoVersions();
    await workspace.writeFile("app/page.tsx", "export default () => 'Draft';");

    const result = await restoreSiteVersion(deps(), ctx("staff"), client, siteId, 1);
    expect(result.restored).toBe(1);
    expect(result.kept).toMatchObject({ number: 3, source: "restore" });
    expect(result.version).toMatchObject({
      number: 4,
      source: "restore",
      message: "Restored version 1",
      createdByUserId: "staff",
    });
    const files = await workspace.versionFiles(result.kept?.id ?? "");
    expect(files.find((f) => f.path === "app/page.tsx")?.content).toBe(
      "export default () => 'Draft';",
    );
    expect(await workspace.readFile("app/page.tsx")).not.toContain("Draft");
    expect(await workspace.changes()).toEqual({ added: [], modified: [], deleted: [] });
    tenant.$client.close();
  });

  it("only works on the session client's own sites", async () => {
    const { siteId, tenant } = await siteWithTwoVersions(clientB);
    const client = await authorized(clientA);
    await expect(siteHistory(deps(), client, siteId)).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(
      restoreSiteVersion(deps(), ctx("staff"), client, siteId, 1),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    await expect(
      bookmarkSiteVersion(deps(), client, siteId, { number: 1, bookmarked: true }),
    ).rejects.toBeInstanceOf(ClientAccessDenied);
    tenant.$client.close();
  });
});

describe("the site preview", () => {
  it("previews the current files, lists the pages and counts the sandbox time", async () => {
    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    const { client, siteId, tenant, workspace } = await siteWithTwoVersions();
    await workspace.writeFile("app/page.tsx", "export default () => 'Draft';");

    const preview = await startSitePreview(deps(), ctx("staff"), client, siteId);
    const runtime = runtimes.runtimes.get(siteRuntimeKey(client, siteId));
    expect(preview).toEqual({
      url: runtime?.previewUrl,
      version: null,
      pages: [
        { route: "/", path: "app/page.tsx" },
        { route: "/about", path: "app/about/page.tsx" },
        { route: "/contact", path: "app/contact/page.tsx" },
        { route: "/services", path: "app/services/page.tsx" },
      ],
    });
    expect(runtime?.readText("app/page.tsx")).toContain("Draft");
    expect(runtime?.previewRunning).toBe(true);
    const events = await db.select().from(usageEvent);
    expect(events.map((e) => [e.kind, e.siteId, e.actorUserId])).toEqual([
      ["sandbox", siteId, "staff"],
    ]);
    tenant.$client.close();
  });

  it("previews one saved version's files", async () => {
    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    const { client, siteId, tenant } = await siteWithTwoVersions();
    const preview = await startSitePreview(deps(), ctx("staff"), client, siteId, { version: 1 });
    expect(preview.version).toBe(1);
    // Its own sandbox: the builder's is never touched.
    expect(runtimes.runtimes.has(siteRuntimeKey(client, siteId))).toBe(false);
    const runtime = runtimes.runtimes.get(versionPreviewKey(client, siteId));
    expect(preview.url).toBe(runtime?.previewUrl);
    expect(runtime?.readText("app/page.tsx")).not.toContain("Two");
    await expect(
      startSitePreview(deps(), ctx("staff"), client, siteId, { version: 7 }),
    ).rejects.toThrow(/no version 7/);
    tenant.$client.close();
  });

  it("refuses without credits and never opens a sandbox", async () => {
    const { client, siteId, tenant } = await siteWithTwoVersions();
    await expect(startSitePreview(deps(), ctx("staff"), client, siteId)).rejects.toThrow(
      /Choose a Locus plan/,
    );
    expect(runtimes.runtimes.size).toBe(0);
    tenant.$client.close();
  });

  it("says so when the packages don't install", async () => {
    await db.insert(agencyComp).values({ organizationId: "agency-a", compedByUserId: "ops" });
    runtimes = new FakeRuntimeProvider({ handler: () => ({ exitCode: 1, stderr: "boom" }) });
    const { client, siteId, tenant } = await siteWithTwoVersions();
    await expect(startSitePreview(deps(), ctx("staff"), client, siteId)).rejects.toThrow(
      /didn't install/,
    );
    tenant.$client.close();
  });
});
