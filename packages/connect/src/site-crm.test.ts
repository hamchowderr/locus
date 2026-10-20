import { createFakeGhl, type FakeGhl, type FakeRoutes } from "@locus/testing";
import { describe, expect, it, vi } from "vitest";
import {
  CrmMediaError,
  downloadMedia,
  isGhlStorageUrl,
  listCalendars,
  listMedia,
  MAX_MEDIA_BYTES,
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
    const png = new Uint8Array([137, 80, 78, 71]);
    const download = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("m1.png")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : new Response("<html>", { headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    const file = await downloadMedia(session, media(), "m1", download);
    expect(file).toEqual({ name: "Logo.png", format: "png", bytes: png });
    expect(vi.mocked(download).mock.calls[0]?.[0]).toBe(`${STORE}/m1.png`);
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
  });

  it("knows GHL's storage hosts from look-alikes", () => {
    expect(isGhlStorageUrl(`${STORE}/x.png`)).toBe(true);
    expect(isGhlStorageUrl("https://assets.cdn.filesafe.space/loc/media/x.png")).toBe(true);
    expect(isGhlStorageUrl("https://storage.googleapis.com/other-bucket/x.png")).toBe(false);
    expect(isGhlStorageUrl("http://assets.cdn.filesafe.space/x.png")).toBe(false);
    expect(isGhlStorageUrl("https://filesafe.space.evil.test/x.png")).toBe(false);
    expect(isGhlStorageUrl("https://user@assets.cdn.filesafe.space/x.png")).toBe(false);
  });
});
