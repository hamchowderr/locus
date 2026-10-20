import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { describe, expect, it, vi } from "vitest";
import { MediaUploadError } from "./media-library.ts";
import {
  CrmMediaError,
  downloadMedia,
  isGhlStorageUrl,
  listCalendars,
  listMedia,
  listProducts,
  MAX_MEDIA_BYTES,
  saveSiteImage,
  siteCrm,
  siteImagesFolderName,
} from "./site-crm.ts";

// Level-1 plumbing for the site builder's CRM reads: the fake GHL plays GoHighLevel and a fake
// download plays GHL's file storage.

const GHL_LOCATION = "ghl-loc-sunrise";
let fake: FakeGhl;
const http = (routes: FakeRoutes) => {
  fake = createFakeGhl(routes);
  return { fetch: fake.fetch, baseUrl: "https://fake.ghl.test" };
};

describe("the builder's calendar list", () => {
  it("lists the client's active calendars with GHL's booking page for each", async () => {
    const options = http({
      "GET /calendars/": {
        body: {
          calendars: [
            { id: "cal1", name: "Consultation", calendarType: "event", isActive: true },
            { id: "cal2", name: "Old", calendarType: "event", isActive: false },
            { id: "../x", name: "Bad id", isActive: true },
          ],
        },
      },
    });
    const list = await listCalendars(
      { token: "t", tokenKind: "location", locationId: GHL_LOCATION },
      options,
    );
    expect(list).toEqual([
      {
        id: "cal1",
        name: "Consultation",
        type: "event",
        embedUrl: "https://api.leadconnectorhq.com/widget/booking/cal1",
      },
    ]);
    expect(fake.requests[0]?.url.searchParams.get("locationId")).toBe(GHL_LOCATION);
    expect(fake.requests[0]?.url.searchParams.get("showDrafted")).toBe("false");
  });
});

describe("the builder's product list", () => {
  it("lists the client's products, newest first, with their one-time prices only", async () => {
    const options = http({
      "GET /products/": {
        body: {
          products: [
            { _id: "prod1", locationId: GHL_LOCATION, name: "Deep\nClean | Package" },
            { _id: "prod2", locationId: GHL_LOCATION, name: "Membership" },
            { _id: "prod3", locationId: "ghl-loc-other", name: "Someone else's" },
            { _id: "../x", locationId: GHL_LOCATION, name: "Bad id" },
          ],
          total: [{ total: 4 }],
        },
      },
      "GET /products/prod1/price": {
        body: {
          prices: [
            {
              _id: "price1",
              product: "prod1",
              name: "Standard",
              type: "one_time",
              currency: "USD",
              amount: 149.5,
            },
            {
              _id: "price2",
              product: "prod1",
              name: "Free",
              type: "one_time",
              currency: "USD",
              amount: 0,
            },
            {
              _id: "price3",
              product: "prod9",
              name: "Other",
              type: "one_time",
              currency: "USD",
              amount: 5,
            },
          ],
          total: 3,
        },
      },
      "GET /products/prod2/price": {
        body: {
          prices: [
            {
              _id: "price4",
              product: "prod2",
              name: "Monthly",
              type: "recurring",
              currency: "USD",
              amount: 30,
              recurring: { interval: "month", intervalCount: 1 },
            },
          ],
          total: 1,
        },
      },
    });
    const list = await listProducts(
      { token: "t", tokenKind: "location", locationId: GHL_LOCATION },
      options,
    );
    expect(list).toEqual([
      {
        id: "prod1",
        name: "Deep Clean Package",
        prices: [{ id: "price1", name: "Standard", amount: 149.5, currency: "USD" }],
      },
    ]);
    const query = fake.requests[0]?.url.searchParams;
    expect(query?.get("locationId")).toBe(GHL_LOCATION);
    expect(query?.get("sortOrder")).toBe("desc");
    expect(query?.get("limit")).toBe("20");
    expect(fake.requests.map((r) => r.url.pathname)).toEqual([
      "/products/",
      "/products/prod1/price",
      "/products/prod2/price",
    ]);
  });
});

describe("the builder's Media Library reads", () => {
  const session = { token: "t", tokenKind: "location" as const, locationId: GHL_LOCATION };
  const STORE = "https://storage.googleapis.com/msgsndr/ghl-loc-sunrise/media";
  const files = [
    { _id: "m1", name: "Logo.png", url: `${STORE}/m1.png`, type: "file" },
    { _id: "m2", name: "brochure.pdf", url: `${STORE}/m2.pdf`, type: "file" },
    { _id: "m3", name: "evil.png", url: "https://evil.test/m3.png", type: "file" },
    { _id: "m4", name: "icon.svg", url: `${STORE}/m4.svg`, type: "file" },
    { _id: "m5", name: "Folder", type: "folder" },
  ];
  const media = () => http({ "GET /medias/files": { body: { files } } });

  it("lists only images on GHL's own storage, newest first", async () => {
    const list = await listMedia(session, media(), "logo");
    expect(list).toEqual([{ id: "m1", name: "Logo.png", format: "png" }]);
    const query = fake.requests[0]?.url.searchParams;
    expect(query?.get("altId")).toBe(GHL_LOCATION);
    expect(query?.get("sortOrder")).toBe("desc");
    expect(query?.get("query")).toBe("logo");
  });

  it("downloads an image only from the address GHL lists for it, and only an image", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const download = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("m1.png")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : new Response("<html>", { headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    const file = await downloadMedia(session, media(), "m1", download);
    expect(file).toEqual({ name: "Logo.png", format: "png", bytes: png });
    expect(vi.mocked(download).mock.calls[0]?.[0]).toBe(`${STORE}/m1.png`);
    // A redirect could lead anywhere: it's an error, not followed.
    expect(vi.mocked(download).mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    // Not listed as an image on GHL's storage: never fetched.
    for (const id of ["m3", "m4", "m2", "nope"]) {
      await expect(downloadMedia(session, media(), id, download)).rejects.toThrow(CrmMediaError);
    }
    expect(vi.mocked(download)).toHaveBeenCalledTimes(1);
  });

  it("refuses a file that isn't the image it says, or is too big", async () => {
    const html = (async () =>
      new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(downloadMedia(session, media(), "m1", html)).rejects.toThrow(/isn't the png/);
    const huge = (async () =>
      new Response(new Uint8Array(MAX_MEDIA_BYTES + 1), {
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    await expect(downloadMedia(session, media(), "m1", huge)).rejects.toThrow(/larger than 4 MB/);
    // No length given, arriving in pieces: still stopped once past the limit.
    const piece = new Uint8Array(1024 * 1024);
    let sent = 0;
    const chunked = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1;
            if (sent > 10) controller.close();
            else controller.enqueue(piece);
          },
        }),
        { headers: { "content-type": "image/png" } },
      )) as typeof fetch;
    await expect(downloadMedia(session, media(), "m1", chunked)).rejects.toThrow(
      /larger than 4 MB/,
    );
    expect(sent).toBeLessThanOrEqual(6);
  });

  it("trusts the file's bytes over its content type, and never names it in an error", async () => {
    const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const as = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
      (async () => new Response(bytes, { headers: { "content-type": type } })) as typeof fetch;
    // Storage's generic type is fine when the bytes are a PNG.
    await expect(
      downloadMedia(session, media(), "m1", as(PNG, "application/octet-stream")),
    ).resolves.toMatchObject({ format: "png" });
    // Labelled a PNG, but isn't one.
    const fake = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const error = await downloadMedia(session, media(), "m1", as(fake, "image/png")).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CrmMediaError);
    expect(String((error as Error).message)).toMatch(/isn't the png/);
    expect(String((error as Error).message)).not.toContain("Logo");
  });

  it("finds an image by the search it was listed with, and tidies names onto one line", async () => {
    const options = http({
      "GET /medias/files": {
        body: {
          files: [{ _id: "m9", name: "Old\nlogo | v1.png", url: `${STORE}/m9.png`, type: "file" }],
        },
      },
    });
    expect(await listMedia(session, options, "logo")).toEqual([
      { id: "m9", name: "Old logo v1.png", format: "png" },
    ]);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const download = (async () =>
      new Response(png, { headers: { "content-type": "image/png" } })) as typeof fetch;
    await downloadMedia(session, options, "m9", download, "logo");
    expect(fake.requests.at(-1)?.url.searchParams.get("query")).toBe("logo");
  });

  it("knows GHL's storage hosts from look-alikes", () => {
    expect(isGhlStorageUrl(`${STORE}/x.png`)).toBe(true);
    expect(isGhlStorageUrl("https://assets.cdn.filesafe.space/loc/media/x.png")).toBe(true);
    expect(isGhlStorageUrl("https://storage.googleapis.com/other-bucket/x.png")).toBe(false);
    // The shared bucket: only this sub-account's own folder.
    expect(isGhlStorageUrl(`${STORE}/x.png`, GHL_LOCATION)).toBe(true);
    expect(
      isGhlStorageUrl("https://storage.googleapis.com/msgsndr/other-loc/x.png", GHL_LOCATION),
    ).toBe(false);
    expect(isGhlStorageUrl("https://app.leadconnectorhq.com/x.png")).toBe(false);
    expect(isGhlStorageUrl("http://assets.cdn.filesafe.space/x.png")).toBe(false);
    expect(isGhlStorageUrl("https://filesafe.space.evil.test/x.png")).toBe(false);
    expect(isGhlStorageUrl("https://user@assets.cdn.filesafe.space/x.png")).toBe(false);
  });
});

describe("keeping a generated image in the Media Library", () => {
  const STORE = `https://storage.googleapis.com/msgsndr/${GHL_LOCATION}/media`;
  const session = { token: "t", tokenKind: "location" as const, locationId: GHL_LOCATION };
  const image = {
    siteId: "site-1",
    name: "../Hero Shot.png",
    bytes: new Uint8Array([137, 80, 78, 71]),
    contentType: "image/png" as const,
  };

  it("uses the site's folder by name and sends the file as multipart", async () => {
    const options = http({
      "GET /medias/files": {
        body: { files: [{ _id: "fold1", type: "folder", name: siteImagesFolderName("site-1") }] },
      },
      "POST /medias/upload-file": {
        body: { fileId: "f1", url: `${STORE}/hero.png` },
      },
    });
    expect(await saveSiteImage(session, options, image)).toEqual({
      fileId: "f1",
      url: `${STORE}/hero.png`,
    });
    const form = fake.requests[1]?.body as FormData;
    expect(form.get("name")).toBe("Hero-Shot.png");
    expect(form.get("parentId")).toBe("fold1");
  });

  it("takes back a file GHL kept outside this sub-account's storage", async () => {
    const options = http({
      "GET /medias/files": {
        body: { files: [{ _id: "fold1", type: "folder", name: siteImagesFolderName("site-1") }] },
      },
      "POST /medias/upload-file": {
        body: { fileId: "f1", url: "https://storage.googleapis.com/msgsndr/other-loc/x.png" },
      },
      "DELETE /medias/f1": { body: {} },
    });
    await expect(saveSiteImage(session, options, image)).rejects.toThrow(MediaUploadError);
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("writes nothing without the medias.write scope", async () => {
    const options = http({ "*": { body: {} } });
    const crm = siteCrm(async () => ({ session, http: options, scopes: ["medias.readonly"] }));
    await expect(crm.saveImage(image)).rejects.toThrow(CrmMediaError);
    expect(fake.requests).toEqual([]);
  });
});
