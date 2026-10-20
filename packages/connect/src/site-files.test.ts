import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, type SessionContext } from "@locus/auth";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import { location, member, organization, site, user } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectError } from "./errors.ts";
import { enableSiteBackend, removeSiteBackend } from "./site-backend.ts";
import {
  deleteSiteFiles,
  MAX_SITE_FILE_BYTES,
  memoryFileStore,
  readSiteFile,
  type SiteFilesDeps,
  siteFileHeaders,
  siteFilesKey,
  siteFilesOverview,
  startSiteFileUpload,
} from "./site-files.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let store: ReturnType<typeof memoryFileStore>;
let deps: SiteFilesDeps;
const KEY = new Uint8Array(32).fill(7);
const SITE = "6f1d2c3a-0000-4000-8000-000000000001";
const OTHER = "6f1d2c3a-0000-4000-8000-000000000002";
const now = new Date();
const ctx: SessionContext = { id: "s-owner", userId: "owner", activeOrganizationId: "agency-a" };
const bearer = (siteId: string) => `Bearer ${siteFilesKey(KEY, siteId)}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-files-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "dbs"));
  store = memoryFileStore();
  deps = { db, store, filesKey: KEY, now: () => 1_000 };
  await db.insert(organization).values({ id: "agency-a", name: "a", slug: "a", createdAt: now });
  await db
    .insert(user)
    .values({ id: "owner", name: "owner", email: "owner@agency.test", emailVerified: true });
  await db.insert(member).values({
    id: "owner@agency-a",
    userId: "owner",
    organizationId: "agency-a",
    role: "owner",
    createdAt: now,
  });
  for (const id of ["client-1", "client-2"]) {
    await db.insert(location).values({
      id,
      organizationId: "agency-a",
      ghlLocationId: `ghl-${id}`,
      name: id,
      tursoDbName: `db-${id}`,
      tursoDbHostname: `db-${id}.turso.test`,
      status: "active",
    });
  }
  await db.insert(site).values({ id: SITE, locationId: "client-1" });
  await db.insert(site).values({ id: OTHER, locationId: "client-2" });
  const owner = await authorizeClient(db, ctx, "client-1");
  await enableSiteBackend({ db, provisioner }, ctx, owner, { siteId: SITE });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const upload = (body: unknown, authorization: string | null = bearer(SITE), siteId = SITE) =>
  startSiteFileUpload(deps, { siteId, authorization, body });

describe("a site's files", () => {
  it("gives the site an upload token for one new file in its own folder", async () => {
    const answer = await upload({
      name: "../My Photo (1).png",
      contentType: "image/png",
      size: 10,
    });
    expect(answer.status).toBe(200);
    const { pathname, token } = answer.body as { pathname: string; token: string };
    expect(pathname).toMatch(new RegExp(`^sites/${SITE}/[0-9a-f-]{36}/My-Photo-1-.png$`));
    expect(token).toBe("memory-token-1");
    expect(answer.body).toMatchObject({ contentType: "image/png" });
    expect(store.tokens).toEqual([
      { pathname, contentType: "image/png", maxBytes: 10, validUntil: 1_000 + 10 * 60 * 1000 },
    ]);
  });

  it("refuses anyone without the site's own key, the same way for every site", async () => {
    const meta = { name: "a.png", contentType: "image/png", size: 1 };
    for (const [authorization, siteId] of [
      [null, SITE],
      ["Bearer wrong", SITE],
      [bearer(OTHER), SITE],
      // A site of another client, with its own key, but no database: it keeps no files.
      [bearer(OTHER), OTHER],
      [bearer("missing"), "missing"],
    ] as const) {
      expect(await upload(meta, authorization, siteId)).toEqual({
        status: 401,
        body: { error: "This site can't keep files." },
      });
    }
    // An offboarded client's site keeps no new files either.
    await db.update(location).set({ status: "suspended" }).where(eq(location.id, "client-1"));
    expect((await upload(meta)).status).toBe(401);
    expect(store.tokens).toEqual([]);
  });

  it("only takes pictures and documents of a sensible size", async () => {
    expect(
      (await upload({ name: "a.exe", contentType: "application/x-msdownload", size: 1 })).status,
    ).toBe(415);
    expect(
      (await upload({ name: "a.png", contentType: "image/png", size: MAX_SITE_FILE_BYTES + 1 }))
        .status,
    ).toBe(413);
    expect((await upload({ name: "a.png", contentType: "image/png", size: 0 })).status).toBe(400);
    expect((await upload({ contentType: "image/png", size: 1 })).status).toBe(400);
  });

  it("reads and deletes only the site's own files", async () => {
    const folder = "0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    const mine = `sites/${SITE}/${folder}/photo.png`;
    const theirs = `sites/${OTHER}/${folder}/photo.png`;
    for (const pathname of [mine, theirs]) {
      store.files.set(pathname, {
        bytes: new TextEncoder().encode("png"),
        contentType: "image/png",
        uploadedAt: now,
      });
    }
    const read = await readSiteFile(deps, {
      siteId: SITE,
      authorization: bearer(SITE),
      pathname: mine,
    });
    expect(read.status).toBe(200);
    if (read.status === 200) expect(await new Response(read.body).text()).toBe("png");
    for (const pathname of [
      theirs,
      `sites/${SITE}/`,
      `sites/${SITE}/photo.png`,
      `sites/${SITE}/../${OTHER}/${folder}/photo.png`,
      // A URL parser turns these into a step up, into the other site's folder.
      `sites/${SITE}/%2e%2e/${OTHER}/${folder}/photo.png`,
      `sites/${SITE}/.%2E/${OTHER}/${folder}/photo.png`,
      `sites/${SITE}/${folder}\\..\\..\\${OTHER}\\${folder}\\photo.png`,
      `sites/${SITE}/${folder}/photo.png?x`,
      `sites/${SITE}/${folder}/photo.png#x`,
      `sites/${SITE}/${folder}/.hidden`,
    ]) {
      expect(
        (await readSiteFile(deps, { siteId: SITE, authorization: bearer(SITE), pathname })).status,
      ).toBe(404);
    }

    expect(
      await deleteSiteFiles(deps, {
        siteId: SITE,
        authorization: bearer(SITE),
        body: { pathnames: [mine, theirs] },
      }),
    ).toMatchObject({ status: 400 });
    expect(store.files.has(mine)).toBe(true);
    expect(
      await deleteSiteFiles(deps, {
        siteId: SITE,
        authorization: bearer(SITE),
        body: { pathnames: [mine] },
      }),
    ).toEqual({ status: 200, body: { deleted: 1 } });
    expect([...store.files.keys()]).toEqual([theirs]);
  });

  it("lists the files on the Database page, for the session's client only", async () => {
    const one = `sites/${SITE}/0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4/one.pdf`;
    store.files.set(one, {
      bytes: new Uint8Array(3),
      contentType: "application/pdf",
      uploadedAt: now,
    });
    const owner = await authorizeClient(db, ctx, "client-1");
    expect((await siteFilesOverview(deps, owner, { siteId: SITE })).files).toEqual([
      { pathname: one, size: 3, uploadedAt: now },
    ]);
    const other = await authorizeClient(db, ctx, "client-2");
    await expect(siteFilesOverview(deps, other, { siteId: SITE })).rejects.toBeInstanceOf(
      ConnectError,
    );

    // Removing the site's database takes its files with it.
    await removeSiteBackend({ db, provisioner, files: store }, ctx, owner, { siteId: SITE });
    expect(store.files.size).toBe(0);
  });

  it("sends a file so the browser never runs it as a page", () => {
    expect(siteFileHeaders("text/csv")).toMatchObject({
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": "attachment",
    });
    expect(siteFileHeaders("image/png")["content-disposition"]).toBeUndefined();
    expect(siteFileHeaders("application/pdf")["content-disposition"]).toBeUndefined();
  });
});
