import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeClient, type SessionContext } from "@locus/auth";
import { type ControlDb, LocalProvisioner, migrateControlDb, openControlDb } from "@locus/db";
import { agencyGhlConnection, location, member, organization, site, user } from "@locus/db/control";
import { createRateLimiter } from "@locus/ghl";
import { MemorySecretStore } from "@locus/secrets";
import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghlSecretRef } from "./agency.ts";
import { ConnectError } from "./errors.ts";
import type { GhlAppConfig } from "./ghl-oauth.ts";
import { enableSiteBackend } from "./site-backend.ts";
import {
  claimSiteUploadTicket,
  deleteSiteFiles,
  issueSiteUploadTicket,
  keepTicketedFile,
  MAX_SITE_FILE_BYTES,
  type SiteFilesDeps,
  siteFilesFolderName,
  siteFilesKey,
  siteFilesOverview,
  uploadSiteFile,
} from "./site-files.ts";

// Level-1 plumbing: the fake GHL plays the client's Media Library. No model is on this path.

const ghl: GhlAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  appId: "app-id",
  redirectUri: "https://locus.test/api/connect/crm/callback",
  scopes: ["medias.write", "medias.readonly"],
};

const KEY = new Uint8Array(32).fill(7);
const SITE = "6f1d2c3a-0000-4000-8000-000000000001";
const OTHER = "6f1d2c3a-0000-4000-8000-000000000002";
const CLOCK = Date.parse("2026-10-20T12:00:00Z");
const ctx: SessionContext = { id: "s-owner", userId: "owner", activeOrganizationId: "agency-a" };
const bearer = (siteId: string) => `Bearer ${siteFilesKey(KEY, siteId)}`;
const fileUrl = (name: string) =>
  `https://storage.googleapis.com/msgsndr/ghl-client-1/media/${name}`;

let dir: string;
let db: ControlDb;
let secrets: MemorySecretStore;
let fake: FakeGhl;
/** The Media Library of ghl-client-1, as the fake keeps it. */
let library: { _id: string; type: string; name: string; parentId?: string; url?: string }[];
let scopes: string;

const routes: FakeRoutes = {
  "POST /oauth/location-token": (req) => ({
    body: {
      access_token: `location-token-${(req.body as { locationId: string }).locationId}`,
      locationId: (req.body as { locationId: string }).locationId,
    },
  }),
  "GET /medias/files": (req) => {
    const q = req.url.searchParams;
    const files = library.filter(
      (f) =>
        f.type === q.get("type") &&
        (!q.get("parentId") || f.parentId === q.get("parentId")) &&
        (!q.get("query") || f.name.includes(q.get("query") ?? "")),
    );
    return { body: { files } };
  },
  "POST /medias/folder": (req) => {
    const folder = { _id: `folder${library.length}`, type: "folder", name: "" };
    folder.name = (req.body as { name: string }).name;
    library.push(folder);
    return { body: folder };
  },
  "POST /medias/upload-file": (req) => {
    const form = req.body as FormData;
    const name = String(form.get("name"));
    const id = `file${library.length}`;
    library.push({
      _id: id,
      type: "file",
      name,
      parentId: String(form.get("parentId")),
      url: fileUrl(`${id}-${name}`),
    });
    return { body: { fileId: id, url: fileUrl(`${id}-${name}`) } };
  },
  "*": (req) => {
    const id = /^\/medias\/([A-Za-z0-9]+)$/.exec(req.url.pathname)?.[1];
    if (req.method === "DELETE" && id) {
      library = library.filter((f) => f._id !== id);
      return { body: {} };
    }
    return { status: 404, body: { message: "not here" } };
  },
};

function deps(): SiteFilesDeps {
  fake = createFakeGhl(routes);
  return {
    db,
    secrets,
    ghl,
    http: { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" },
    now: () => CLOCK,
    rateLimiter: createRateLimiter(),
    filesKey: KEY,
    ipHashKey: Buffer.alloc(32, 3),
  };
}

const png = (name = "../My Photo (1).png", bytes = 3) =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });

const upload = (
  d: SiteFilesDeps,
  file: File | null = png(),
  authorization: string | null = bearer(SITE),
  siteId = SITE,
) => uploadSiteFile(d, { siteId, authorization, file, visitorIp: "203.0.113.9" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-site-files-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  secrets = new MemorySecretStore();
  library = [];
  scopes = "medias.write medias.readonly oauth.write";
  const now = new Date(CLOCK);
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
  await db.insert(site).values({ id: SITE, locationId: "client-1", status: "deployed" });
  await db.insert(site).values({ id: OTHER, locationId: "client-2", status: "deployed" });
  const owner = await authorizeClient(db, ctx, "client-1");
  await enableSiteBackend({ db, provisioner: new LocalProvisioner(join(dir, "dbs")) }, ctx, owner, {
    siteId: SITE,
  });
  await secrets.set(
    ghlSecretRef("agency-a"),
    JSON.stringify({
      accessToken: "agency-token",
      refreshToken: "refresh-token",
      expiresAt: CLOCK + 24 * 3_600_000,
      scopes,
      companyId: "company-1",
      installedBy: "user-1",
    }),
  );
  await db.insert(agencyGhlConnection).values({
    organizationId: "agency-a",
    ghlCompanyId: "company-1",
    scopes,
    secretRef: ghlSecretRef("agency-a"),
    connectedAt: new Date(CLOCK),
  });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a site's files", () => {
  it("go into the site's own folder in its client's Media Library", async () => {
    const d = deps();
    const answer = await upload(d);
    expect(answer).toEqual({
      status: 200,
      body: {
        fileId: "file1",
        url: fileUrl("file1-My-Photo-1-.png"),
        name: "My-Photo-1-.png",
        contentType: "image/png",
        size: 3,
      },
    });
    // Minted for the site's own sub-account, from its registry row.
    expect(fake.requests[0]?.body).toMatchObject({ locationId: "ghl-client-1" });
    expect(library[0]).toMatchObject({ type: "folder", name: siteFilesFolderName(SITE) });
    expect(library[1]).toMatchObject({ type: "file", parentId: library[0]?._id });

    // The folder is made once.
    await upload(deps(), png("second.png"));
    expect(library.filter((f) => f.type === "folder")).toHaveLength(1);
  });

  it("refuses anyone without the site's own key, the same way for every site", async () => {
    for (const [authorization, siteId] of [
      [null, SITE],
      ["Bearer wrong", SITE],
      [bearer(OTHER), SITE],
      // A site of another client, with its own key, but no database: it keeps no files.
      [bearer(OTHER), OTHER],
      [bearer("missing"), "missing"],
    ] as const) {
      expect(await upload(deps(), png(), authorization, siteId)).toEqual({
        status: 401,
        body: { error: "This site can't keep files." },
      });
    }
    // An offboarded client's site, or one not published, keeps no new files either.
    await db.update(location).set({ status: "suspended" }).where(eq(location.id, "client-1"));
    expect((await upload(deps())).status).toBe(401);
    await db.update(location).set({ status: "active" }).where(eq(location.id, "client-1"));
    await db.update(site).set({ status: "draft" }).where(eq(site.id, SITE));
    expect((await upload(deps())).status).toBe(401);
    expect(library).toEqual([]);
  });

  it("only takes pictures and documents of a sensible size", async () => {
    const d = deps();
    const exe = new File([new Uint8Array(1)], "a.exe", { type: "application/x-msdownload" });
    const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
    expect((await upload(d, exe)).status).toBe(415);
    expect((await upload(d, svg)).status).toBe(415);
    expect((await upload(d, png("a.png", MAX_SITE_FILE_BYTES + 1))).status).toBe(413);
    expect((await upload(d, png("a.png", 0))).status).toBe(400);
    expect((await upload(d, null)).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("says so when the agency's HighLevel connection can't keep files", async () => {
    await db
      .update(agencyGhlConnection)
      .set({ scopes: "oauth.write" })
      .where(eq(agencyGhlConnection.organizationId, "agency-a"));
    const stored = JSON.parse((await secrets.get(ghlSecretRef("agency-a"))) ?? "{}");
    await secrets.set(
      ghlSecretRef("agency-a"),
      JSON.stringify({ ...stored, scopes: "oauth.write" }),
    );
    expect(await upload(deps())).toMatchObject({ status: 403 });
    expect(library).toEqual([]);
  });

  it("deletes only files in the site's folders, so a retry after a partial delete works", async () => {
    await upload(deps());
    library.push({ _id: "elsewhere", type: "file", name: "x.png", url: fileUrl("x.png") });
    const remove = (fileIds: unknown) =>
      deleteSiteFiles(deps(), { siteId: SITE, authorization: bearer(SITE), body: { fileIds } });
    expect(await remove(["../x"])).toMatchObject({ status: 400 });
    expect(await remove(["file1", "elsewhere"])).toEqual({ status: 200, body: { deleted: 1 } });
    expect(library.map((f) => f._id)).not.toContain("file1");
    expect(library.map((f) => f._id)).toContain("elsewhere");
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.url.pathname)).toEqual([
      "/medias/file1",
    ]);
    // Already gone: nothing to do, and no error.
    expect(await remove(["file1"])).toEqual({ status: 200, body: { deleted: 0 } });
  });

  it("treats every folder with the site's name as the site's, and finds a folder GHL made without saying its id", async () => {
    // GHL's documented answer to making a folder carries no id.
    const quiet: FakeRoutes = {
      ...routes,
      "POST /medias/folder": (req) => {
        (routes["POST /medias/folder"] as (r: typeof req) => unknown)(req);
        return { body: { name: (req.body as { name: string }).name, type: "folder" } };
      },
    };
    const d = {
      ...deps(),
      http: { fetch: createFakeGhl(quiet).fetch, baseUrl: "https://fake.ghl.test" },
    };
    expect((await upload(d)).status).toBe(200);
    // A second folder of the same name, as two first uploads at once could make.
    library.push({ _id: "twin", type: "folder", name: siteFilesFolderName(SITE) });
    library.push({ _id: "late", type: "file", name: "b.png", parentId: "twin", url: fileUrl("b") });
    const owner = await authorizeClient(db, ctx, "client-1");
    const listed = await siteFilesOverview(deps(), owner, { siteId: SITE });
    expect(listed.files.map((f) => f.id).sort()).toEqual(["file1", "late"]);
    expect(
      await deleteSiteFiles(deps(), {
        siteId: SITE,
        authorization: bearer(SITE),
        body: { fileIds: ["late"] },
      }),
    ).toEqual({ status: 200, body: { deleted: 1 } });
  });

  it("limits how fast one site takes uploads", async () => {
    const d = { ...deps(), limits: { perIp: { max: 1, windowMs: 60_000 } } };
    expect((await upload(d)).status).toBe(200);
    expect(await upload(d)).toMatchObject({ status: 429 });
  });

  it("lists the files on the Database page, for the session's client only", async () => {
    await upload(deps());
    const owner = await authorizeClient(db, ctx, "client-1");
    const listed = await siteFilesOverview(deps(), owner, { siteId: SITE });
    expect(listed.files.map((f) => f.id)).toEqual(["file1"]);
    const other = await authorizeClient(db, ctx, "client-2");
    await expect(siteFilesOverview(deps(), other, { siteId: SITE })).rejects.toBeInstanceOf(
      ConnectError,
    );
  });
});

describe("a site's bigger files, sent with a ticket", () => {
  const TICKET_KEY = new Uint8Array(32).fill(9);
  const UPLOAD_URL = "https://agent.test/site-files/upload";
  const MB = 1024 * 1024;
  const ticketDeps = (now = CLOCK) => ({
    ...deps(),
    now: () => now,
    ticketKey: TICKET_KEY,
    uploadUrl: UPLOAD_URL as string | null,
  });
  const ask = async (
    body: unknown,
    d = ticketDeps(),
    authorization: string | null = bearer(SITE),
    siteId = SITE,
  ) => issueSiteUploadTicket(d, { siteId, authorization, body, visitorIp: "203.0.113.9" });
  const ticketOf = (answer: { body: Record<string, unknown> }) => answer.body.ticket as string;
  const claim = (
    ticket: string | null,
    contentType = "video/mp4",
    size: number | null = null,
    now = CLOCK,
  ) => claimSiteUploadTicket(ticketDeps(now), { ticket, contentType, size });
  const blob = (bytes: number, type = "video/mp4") => new Blob([new Uint8Array(bytes)], { type });

  it("lets the member's browser send one file of the size and type it was given for", async () => {
    const asked = await ask({ name: "Tour (1).mp4", contentType: "video/mp4", size: 30 * MB });
    expect(asked).toMatchObject({
      status: 200,
      body: { uploadUrl: UPLOAD_URL, contentType: "video/mp4", expiresAt: CLOCK + 600_000 },
    });
    // Asking for a ticket touches nothing in HighLevel.
    expect(fake.requests).toEqual([]);

    const claimed = await claim(ticketOf(asked), "video/mp4", 30 * MB);
    if (!("claim" in claimed)) throw new Error("not claimed");
    expect(claimed.claim).toEqual({
      siteId: SITE,
      name: "Tour-1-.mp4",
      contentType: "video/mp4",
      size: 30 * MB,
    });
    // Once claimed, the ticket can't start a second copy, even while the first still arrives.
    expect(await claim(ticketOf(asked))).toMatchObject({ answer: { status: 409 } });

    // The file may take longer to arrive than the ticket lives.
    const d = { ...ticketDeps(CLOCK + 3_600_000) };
    expect(await keepTicketedFile(d, claimed.claim, blob(30 * MB))).toMatchObject({
      status: 200,
      body: { fileId: "file1", name: "Tour-1-.mp4", contentType: "video/mp4", size: 30 * MB },
    });
    expect(fake.requests[0]?.body).toMatchObject({ locationId: "ghl-client-1" });
    expect(library[1]).toMatchObject({ type: "file", parentId: library[0]?._id });
    // A claim is kept once.
    await expect(keepTicketedFile(d, claimed.claim, blob(30 * MB))).rejects.toThrow(/claimed/);
    await expect(keepTicketedFile(d, { ...claimed.claim }, blob(30 * MB))).rejects.toThrow(
      /claimed/,
    );
  });

  it("refuses an upload that isn't the file the ticket names, before taking any of it", async () => {
    const asked = await ask({ name: "a.pdf", contentType: "application/pdf", size: 10 * MB });
    const ticket = ticketOf(asked);
    expect(await claim(ticket, "image/png")).toMatchObject({ answer: { status: 400 } });
    expect(await claim(ticket, "application/pdf", 10 * MB + 1)).toMatchObject({
      answer: { status: 400 },
    });
    // Those didn't use it up; a short body is still refused once it has arrived.
    const claimed = await claim(ticket, "application/pdf; charset=binary");
    if (!("claim" in claimed)) throw new Error("not claimed");
    expect(await keepTicketedFile(ticketDeps(), claimed.claim, blob(10 * MB - 1))).toEqual({
      status: 400,
      body: { error: "That isn't the file this upload was for." },
    });
    expect(library).toEqual([]);
  });

  it("refuses a ticket that is forged, changed, expired, or for a site that no longer keeps files", async () => {
    const ticket = ticketOf(await ask({ name: "a.mp4", contentType: "video/mp4", size: 10 }));
    const [payload, mac] = ticket.split(".");
    const bigger = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
        z: 500 * MB,
      }),
    ).toString("base64url");
    for (const value of [null, "", "x.y", `${bigger}.${mac}`, `${payload}.${mac}x`]) {
      expect(await claim(value)).toMatchObject({ answer: { status: 401 } });
    }
    expect(await claim(ticket, "video/mp4", null, CLOCK + 600_001)).toMatchObject({
      answer: { status: 401 },
    });
    // Signed with another key (say, another deployment's): refused.
    expect(
      await claimSiteUploadTicket(
        { ...ticketDeps(), ticketKey: new Uint8Array(32).fill(1) },
        { ticket, contentType: "video/mp4", size: null },
      ),
    ).toMatchObject({ answer: { status: 401 } });

    const claimed = await claim(ticket);
    if (!("claim" in claimed)) throw new Error("not claimed");
    await db.update(site).set({ status: "draft" }).where(eq(site.id, SITE));
    expect(await keepTicketedFile(ticketDeps(), claimed.claim, blob(10))).toEqual({
      status: 401,
      body: { error: "This site can't keep files." },
    });
    expect(library).toEqual([]);
  });

  it("only gives tickets to the site itself, for files of a sensible kind and size", async () => {
    for (const [authorization, siteId] of [
      [null, SITE],
      [bearer(OTHER), SITE],
      [bearer(OTHER), OTHER],
    ] as const) {
      expect(
        await ask(
          { name: "a.mp4", contentType: "video/mp4", size: 10 },
          ticketDeps(),
          authorization,
          siteId,
        ),
      ).toMatchObject({ status: 401 });
    }
    expect((await ask({ name: "a.mp4", contentType: "video/mp4", size: 501 * MB })).status).toBe(
      413,
    );
    expect((await ask({ name: "a.png", contentType: "image/png", size: 26 * MB })).status).toBe(
      413,
    );
    expect((await ask({ name: "a.svg", contentType: "image/svg+xml", size: 10 })).status).toBe(415);
    expect((await ask({ name: "a.png", contentType: "image/png", size: 0 })).status).toBe(400);
    expect((await ask({ contentType: "image/png", size: 10 })).status).toBe(400);
    expect((await ask({ name: "a.png", contentType: "image/png", size: 1.5 })).status).toBe(400);
    // Any name makes a short ticket the upload server takes.
    const odd = await ask({ name: "\u0001".repeat(300), contentType: "image/png", size: 10 });
    expect("claim" in (await claim(ticketOf(odd), "image/png"))).toBe(true);
  });

  it("says there's nowhere to send big files when Locus has no upload server", async () => {
    expect(
      await ask(
        { name: "a.mp4", contentType: "video/mp4", size: 10 },
        { ...ticketDeps(), uploadUrl: null },
      ),
    ).toEqual({ status: 200, body: { uploadUrl: null } });
  });

  it("gives a site far fewer tickets than ordinary uploads", async () => {
    const d = { ...ticketDeps(), bigLimits: { perSiteBurst: { max: 2, windowMs: 60_000 } } };
    const one = { name: "a.mp4", contentType: "video/mp4", size: 10 };
    expect((await ask(one, d)).status).toBe(200);
    expect((await ask(one, d)).status).toBe(200);
    expect(await ask(one, d)).toMatchObject({ status: 429 });
    // Ordinary uploads have their own, larger budget.
    expect((await upload(deps())).status).toBe(200);
  });
});
