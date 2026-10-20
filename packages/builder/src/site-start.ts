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
  /** A screenshot to take after. */
  screenshot?: { bytes: Uint8Array; mediaType: string } | null;
}

/** A design answer the form can't use, in words for the person. */
export class DesignInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignInputError";
  }
}

const PAGE_OPTIONS = new Set(DESIGN_QUESTIONS.find((q) => q.id === "pages")?.options ?? []);

/** Whether the bytes really are the image type they claim, from their first bytes. */
function looksLike(bytes: Uint8Array, mediaType: keyof typeof SCREENSHOT_TYPES): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  switch (mediaType) {
    case "image/png":
      return bytes[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
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
    const palette = PALETTE_PRESETS[input.palette];
    if (!palette) throw new DesignInputError("Pick one of the colour choices.");
    brief.palette = palette;
  }
  if (input.fonts) {
    const fonts = FONT_PRESETS[input.fonts];
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
      parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
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
    const { bytes, mediaType } = input.screenshot;
    const type = mediaType as keyof typeof SCREENSHOT_TYPES;
    if (!(type in SCREENSHOT_TYPES) || !looksLike(bytes, type)) {
      throw new DesignInputError("The screenshot has to be a PNG, JPEG or WebP image.");
    }
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new DesignInputError(
        `The screenshot is too big. Keep it under ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB.`,
      );
    }
    const path = `${REFERENCE_FOLDER}/screenshot-1.${SCREENSHOT_TYPES[type]}`;
    files.push({ path, content: bytes });
    references.push({ kind: "screenshot", path, note: "A screenshot the person likes" });
  }
  if (references.length > 0) brief.references = references;
  return { brief, files };
}
