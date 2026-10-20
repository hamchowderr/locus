import { describe, expect, it } from "vitest";
import {
  DesignBrief,
  ghlTrackingFile,
  isGhlTrackingHost,
  layoutWithTracking,
  parseTrackingSnippet,
  renderTemplate,
  TEMPLATES,
} from "./index.ts";

const SNIPPET =
  '<script src="https://link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_abc12345def"></script>';

describe("GHL's tracking snippet", () => {
  it("reads the script and tracking id GHL shows, quoted either way", () => {
    expect(parseTrackingSnippet(SNIPPET)).toEqual({
      src: "https://link.msgsndr.com/js/external-tracking.js",
      trackingId: "tk_abc12345def",
    });
    expect(
      parseTrackingSnippet(
        "<script data-tracking-id='tk_abc12345def' src='https://link.myagency.com/js/external-tracking.js'>",
      ),
    ).toEqual({
      src: "https://link.myagency.com/js/external-tracking.js",
      trackingId: "tk_abc12345def",
    });
  });

  it("refuses anything that isn't that script", () => {
    for (const bad of [
      "tk_abc12345def",
      '<script src="https://link.msgsndr.com/js/other.js" data-tracking-id="tk_abc12345def">',
      '<script src="https://link.msgsndr.com:8443/js/external-tracking.js" data-tracking-id="tk_abc12345def">',
      '<script src="https://u:p@link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_abc12345def">',
      '<script src="https://link.msgsndr.com/js/external-tracking.js?x=1" data-tracking-id="tk_abc12345def">',
      '<script src="javascript:alert(1)" data-tracking-id="tk_abc12345def">',
      '<script src="https://link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_a\\"};alert(1)//">',
      `${SNIPPET}${" ".repeat(2000)}`,
    ]) {
      expect(parseTrackingSnippet(bad)).toBeNull();
    }
  });

  it("knows GHL's own domains from an agency's", () => {
    expect(isGhlTrackingHost("https://link.msgsndr.com/js/external-tracking.js")).toBe(true);
    expect(isGhlTrackingHost("https://link.leadconnectorhq.com/js/external-tracking.js")).toBe(
      true,
    );
    expect(isGhlTrackingHost("https://link.myagency.com/js/external-tracking.js")).toBe(false);
    expect(isGhlTrackingHost("https://msgsndr.com.evil.test/js/external-tracking.js")).toBe(false);
  });

  it("loads only on the published site", () => {
    const tracking = parseTrackingSnippet(SNIPPET);
    if (!tracking) throw new Error("snippet");
    const { content } = ghlTrackingFile(tracking);
    expect(content).toContain("if (!locus.leadEndpoint) return null;");
    expect(content).toContain('strategy="afterInteractive"');
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    "goes into the %s layout once, after the imports and inside <body>",
    (_, template) => {
      const files = renderTemplate(template, DesignBrief.parse({ name: "Sunrise Dental" }));
      const layout = String(files.find((f) => f.path === "app/layout.tsx")?.content);
      const updated = layoutWithTracking(layout);
      expect(updated).toContain(
        'import "./globals.css";\nimport { GhlTracking } from "@/components/ghl-tracking";',
      );
      expect(updated).toMatch(/\n(\s+)<GhlTracking \/>\n\s+<\/body>/);
      expect(layoutWithTracking(updated ?? "")).toBe(updated);
    },
  );

  it("has nowhere to go in a layout without <body>", () => {
    expect(layoutWithTracking("export default function L() {}")).toBeNull();
  });
});
