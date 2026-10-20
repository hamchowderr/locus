/**
 * The names the preview's visual-edits script and the Locus editor share. Kept apart from the
 * rest of `@locus/studio` so the browser can import them without the database code.
 */

/** The attribute naming where an element starts in the site's source, `path:offset`. */
export const SOURCE_ATTR = "data-locus-src";

/** The `source` every visual-edits `postMessage` carries, both ways. */
export const VISUAL_EDITS_MESSAGE = "locus-visual-edits";
