import {
  DESIGN_QUESTIONS,
  type DesignBrief,
  FONT_PRESETS,
  MAX_SCREENSHOT_BYTES,
  PALETTE_PRESETS,
  REFERENCE_FOLDER,
  SCREENSHOT_TYPES,
  type SiteFile,
} from "@locus/studio";
import type { z } from "zod";

// What the New site form may add to a site's start besides its name, kind and template: the
// guided design answers, a site the person likes and a screenshot. All of it is optional; the
// builder asks in the chat for what's missing.

export interface NewSiteDesign {
  /** What the person wants, in their words. */
  description?: string;
  /** One of the goal question's options, or the person's own words. */
  goal?: string;
  audience?: string;
  /** A `PALETTE_PRESETS` name. */
  palette?: string;
  /** A `FONT_PRESETS` name. */
  fonts?: string;
  layout?: string;
  pages?: string[];
  /** A website to take after. */
  referenceUrl?: string;
  /** A screenshot to take after. Its type is read from its bytes; `mediaType` is only a claim. */
  screenshot?: { bytes: Uint8Array; mediaType?: string } | null;
}

/** A design answer the form can't use, in words for the person. */
export class DesignInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignInputError";
  }
}

const PAGE_OPTIONS = new Set(DESIGN_QUESTIONS.find((q) => q.id === "pages")?.options ?? []);

/** The longest side a reference screenshot may have: models refuse larger images. */
export const MAX_SCREENSHOT_SIDE = 8000;

type ImageInfo = { mediaType: keyof typeof SCREENSHOT_TYPES; width: number; height: number };

/**
 * An image's real type and size from its first bytes (PNG, JPEG or WebP), whatever the browser
 * said it was, or null for anything else.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const u16 = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  const le16 = (at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const le24 = (at: number) => le16(at) | ((bytes[at + 2] ?? 0) << 16);
  const b = (at: number) => bytes[at] ?? 0;
  if (bytes.length >= 24 && b(0) === 0x89 && ascii(1, 4) === "PNG" && ascii(12, 16) === "IHDR") {
    return {
      mediaType: "image/png",
      width: u16(16) * 65536 + u16(18),
      height: u16(20) * 65536 + u16(22),
    };
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    // Walk the segments to the frame header (SOF0-SOF15, except DHT, JPG and DAC).
    let at = 2;
    while (at + 9 < bytes.length) {
      if (b(at) !== 0xff) return null;
      const marker = b(at + 1);
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mediaType: "image/jpeg", width: u16(at + 7), height: u16(at + 5) };
      }
      at += 2 + u16(at + 2);
    }
    return null;
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    switch (ascii(12, 16)) {
      case "VP8 ":
        return { mediaType: "image/webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      case "VP8L":
        return {
          mediaType: "image/webp",
          width: 1 + (((b(22) & 0x3f) << 8) | b(21)),
          height: 1 + (((b(24) & 0x0f) << 10) | (b(23) << 2) | ((b(22) & 0xc0) >> 6)),
        };
      case "VP8X":
        return { mediaType: "image/webp", width: 1 + le24(24), height: 1 + le24(27) };
    }
  }
  return null;
}

const trimmed = (value: string | undefined, max: number, label: string) => {
  const text = value?.trim() ?? "";
  if (text.length > max) throw new DesignInputError(`Keep ${label} under ${max} characters.`);
  return text || undefined;
};

/**
 * The brief fields and starting files for the form's design answers. Refuses an unknown
 * palette or font choice, an address that isn't a web page, and a screenshot that isn't a PNG,
 * JPEG or WebP image of at most `MAX_SCREENSHOT_BYTES`.
 */
export function designFromForm(input: NewSiteDesign): {
  brief: Partial<z.input<typeof DesignBrief>>;
  files: SiteFile[];
} {
  const brief: Partial<z.input<typeof DesignBrief>> = {};
  const files: SiteFile[] = [];
  const description = trimmed(input.description, 4000, "the description");
  if (description) brief.description = description;
  const goal = trimmed(input.goal, 500, "the goal");
  if (goal) brief.goal = goal;
  const audience = trimmed(input.audience, 500, "who the site is for");
  if (audience) brief.audience = audience;
  if (input.palette) {
    const palette = Object.hasOwn(PALETTE_PRESETS, input.palette)
      ? PALETTE_PRESETS[input.palette]
      : undefined;
    if (!palette) throw new DesignInputError("Pick one of the colour choices.");
    brief.palette = palette;
  }
  if (input.fonts) {
    const fonts = Object.hasOwn(FONT_PRESETS, input.fonts) ? FONT_PRESETS[input.fonts] : undefined;
    if (!fonts) throw new DesignInputError("Pick one of the lettering choices.");
    brief.fonts = fonts;
  }
  if (input.layout) {
    if (input.layout !== "single-page" && input.layout !== "multi-page") {
      throw new DesignInputError("Pick one page or several pages.");
    }
    brief.layout = input.layout;
  }
  const pages = (input.pages ?? []).filter((p) => p);
  if (pages.length > 0) {
    if (pages.some((p) => !PAGE_OPTIONS.has(p))) {
      throw new DesignInputError("Pick pages from the list.");
    }
    brief.pages = [...new Set(pages)];
  }
  const references: NonNullable<DesignBrief["references"]> = [];
  const url = input.referenceUrl?.trim();
  if (url) {
    let parsed: URL | null = null;
    try {
      // "example.com:8080" has no scheme; only "something://" does.
      parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new DesignInputError("Give the site you like as a web address, like example.com.");
    }
    if (parsed.toString().length > 2000) throw new DesignInputError("That address is too long.");
    references.push({ kind: "url", url: parsed.toString(), note: "A site the person likes" });
  }
  if (input.screenshot && input.screenshot.bytes.byteLength > 0) {
    // The bytes decide the type; what the browser claimed is ignored.
    const { bytes } = input.screenshot;
    const info = imageInfo(bytes);
    if (!info) throw new DesignInputError("The screenshot has to be a PNG, JPEG or WebP image.");
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new DesignInputError(
        `The screenshot is too big. Keep it under ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB.`,
      );
    }
    if (Math.max(info.width, info.height) > MAX_SCREENSHOT_SIDE) {
      throw new DesignInputError(
        `The screenshot is ${info.width} × ${info.height} pixels. Crop it to at most ` +
          `${MAX_SCREENSHOT_SIDE} pixels on each side.`,
      );
    }
    const path = `${REFERENCE_FOLDER}/screenshot-1.${SCREENSHOT_TYPES[info.mediaType]}`;
    files.push({ path, content: bytes });
    references.push({ kind: "screenshot", path, note: "A screenshot the person likes" });
  }
  if (references.length > 0) brief.references = references;
  return { brief, files };
}
