import { describe, expect, it } from "vitest";
import { DesignInputError, designFromForm } from "./site-start.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

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
    expect(() => designFromForm({ fonts: "Comic" })).toThrow(DesignInputError);
    expect(() => designFromForm({ layout: "tiles" })).toThrow(DesignInputError);
    expect(() => designFromForm({ pages: ["Admin"] })).toThrow(DesignInputError);
    expect(() => designFromForm({ referenceUrl: "javascript:alert(1)" })).toThrow(/web address/);
    expect(() => designFromForm({ referenceUrl: "ftp://example.com" })).toThrow(/web address/);
    expect(() =>
      designFromForm({
        screenshot: { bytes: new TextEncoder().encode("<svg/>"), mediaType: "image/png" },
      }),
    ).toThrow(/PNG, JPEG or WebP/);
    expect(() =>
      designFromForm({ screenshot: { bytes: PNG, mediaType: "image/svg+xml" } }),
    ).toThrow(/PNG, JPEG or WebP/);
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(() => designFromForm({ screenshot: { bytes: big, mediaType: "image/png" } })).toThrow(
      /too big/,
    );
  });
});
