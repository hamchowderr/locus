import { describe, expect, it } from "vitest";
import { DesignInputError, designFromForm, imageInfo } from "./site-start.ts";

/** The start of a PNG: signature and IHDR with its size, which is all the checks read. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
const PNG = png(1440, 4000);

describe("designFromForm", () => {
  it("turns the form's answers into brief fields and a screenshot file", () => {
    const { brief, files } = designFromForm({
      description: "  A friendly dental site ",
      goal: "Book an appointment",
      audience: "",
      palette: "Warm and earthy",
      fonts: "Friendly (Poppins)",
      layout: "multi-page",
      pages: ["Home", "Services", "Home"],
      referenceUrl: "brightsmiles.example",
      screenshot: { bytes: PNG, mediaType: "image/png" },
    });
    expect(brief).toEqual({
      description: "A friendly dental site",
      goal: "Book an appointment",
      palette: {
        primary: "#b45309",
        accent: "#4d7c0f",
        background: "#fffbeb",
        foreground: "#292524",
      },
      fonts: { heading: "Poppins", body: "Open Sans" },
      layout: "multi-page",
      pages: ["Home", "Services"],
      references: [
        { kind: "url", url: "https://brightsmiles.example/", note: "A site the person likes" },
        {
          kind: "screenshot",
          path: "design/references/screenshot-1.png",
          note: "A screenshot the person likes",
        },
      ],
    });
    expect(files).toEqual([{ path: "design/references/screenshot-1.png", content: PNG }]);
  });

  it("leaves everything out when nothing was answered", () => {
    expect(designFromForm({ pages: [], screenshot: null })).toEqual({ brief: {}, files: [] });
  });

  it("refuses answers the form doesn't offer and files that aren't images", () => {
    expect(() => designFromForm({ palette: "Neon" })).toThrow(DesignInputError);
    expect(() => designFromForm({ palette: "constructor" })).toThrow(DesignInputError);
    expect(() => designFromForm({ fonts: "Comic" })).toThrow(DesignInputError);
    expect(() => designFromForm({ fonts: "toString" })).toThrow(DesignInputError);
    expect(() => designFromForm({ layout: "tiles" })).toThrow(DesignInputError);
    expect(() => designFromForm({ pages: ["Admin"] })).toThrow(DesignInputError);
    expect(() => designFromForm({ referenceUrl: "javascript:alert(1)" })).toThrow(/web address/);
    expect(() => designFromForm({ referenceUrl: "ftp://example.com" })).toThrow(/web address/);
    expect(() =>
      designFromForm({
        screenshot: { bytes: new TextEncoder().encode("<svg/>"), mediaType: "image/png" },
      }),
    ).toThrow(/PNG, JPEG or WebP/);
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(() => designFromForm({ screenshot: { bytes: big } })).toThrow(/too big/);
    expect(() => designFromForm({ screenshot: { bytes: png(1440, 9000) } })).toThrow(
      /1440 × 9000 pixels/,
    );
  });

  it("reads the type from the bytes, not from what the browser said", () => {
    const { files } = designFromForm({ screenshot: { bytes: PNG, mediaType: "image/webp" } });
    expect(files.map((f) => f.path)).toEqual(["design/references/screenshot-1.png"]);
  });

  it("takes an address with a port as a web address", () => {
    expect(designFromForm({ referenceUrl: "example.com:8080/menu" }).brief.references).toEqual([
      { kind: "url", url: "https://example.com:8080/menu", note: "A site the person likes" },
    ]);
  });
});

describe("imageInfo", () => {
  it("reads the type and size of PNG, JPEG and WebP images", () => {
    expect(imageInfo(png(800, 600))).toEqual({ mediaType: "image/png", width: 800, height: 600 });
    // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03,
    ]);
    expect(imageInfo(jpeg)).toEqual({ mediaType: "image/jpeg", width: 640, height: 480 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
    webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24); // 800 × 600, each stored minus one
    expect(imageInfo(webp)).toEqual({ mediaType: "image/webp", width: 800, height: 600 });
    expect(imageInfo(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});
