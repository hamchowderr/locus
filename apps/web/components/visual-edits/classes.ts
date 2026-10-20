/**
 * Style controls for Visual edits, as Tailwind classes: each control owns one group of classes
 * (text colour, size, padding…) and swaps the class of its group in an element's `className`,
 * leaving every other class, and every responsive or state variant (`sm:`, `hover:`), alone.
 */

const SIZES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];
const ALIGN = ["left", "center", "right", "justify", "start", "end"];
const TEXT_UTILITIES = ["balance", "pretty", "wrap", "nowrap", "ellipsis", "clip"];

export interface StyleGroup {
  id: string;
  label: string;
  /** Whether a class (no variant prefix) belongs to this group. */
  matches: (cls: string) => boolean;
  options: { value: string; label: string }[];
}

const colorOf = (prefix: string) => (cls: string) => {
  if (!cls.startsWith(`${prefix}-`)) return false;
  const rest = cls.slice(prefix.length + 1);
  if (prefix === "text" && (SIZES.includes(rest) || ALIGN.includes(rest))) return false;
  if (prefix === "text" && TEXT_UTILITIES.includes(rest)) return false;
  return (
    /^(\[[^\]]+\]|[a-z]+(-[a-z]+)?(-\d{2,3})?)(\/\d{1,3})?$/.test(rest) &&
    !/^(none|auto)$/.test(rest)
  );
};

/** The site's theme colours (CSS variables from `app/globals.css`), then a few fixed ones. */
export const THEME_COLORS = [
  "primary",
  "primary-foreground",
  "secondary",
  "accent",
  "muted",
  "muted-foreground",
  "foreground",
  "background",
];
export const PALETTE = [
  "white",
  "black",
  "slate-900",
  "slate-500",
  "red-600",
  "orange-500",
  "amber-400",
  "green-600",
  "teal-600",
  "sky-500",
  "blue-600",
  "indigo-600",
  "purple-600",
  "pink-600",
];

export const TEXT_COLOR: StyleGroup = {
  id: "text-color",
  label: "Text colour",
  matches: colorOf("text"),
  options: [...THEME_COLORS, ...PALETTE].map((c) => ({ value: `text-${c}`, label: c })),
};

export const BACKGROUND: StyleGroup = {
  id: "background",
  label: "Background",
  matches: (cls) =>
    colorOf("bg")(cls) &&
    !/^bg-(gradient|linear|radial|conic|clip|origin|fixed|local|scroll|cover|contain|center|repeat|no-repeat)/.test(
      cls,
    ),
  options: [
    { value: "", label: "none" },
    ...[...THEME_COLORS, ...PALETTE].map((c) => ({ value: `bg-${c}`, label: c })),
  ],
};

export const TEXT_SIZE: StyleGroup = {
  id: "text-size",
  label: "Text size",
  matches: (cls) => SIZES.some((s) => cls === `text-${s}`),
  options: SIZES.map((s) => ({ value: `text-${s}`, label: s })),
};

export const WEIGHT: StyleGroup = {
  id: "weight",
  label: "Weight",
  matches: (cls) =>
    /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(cls),
  options: ["normal", "medium", "semibold", "bold"].map((w) => ({ value: `font-${w}`, label: w })),
};

export const ALIGNMENT: StyleGroup = {
  id: "align",
  label: "Alignment",
  matches: (cls) => ALIGN.some((a) => cls === `text-${a}`),
  options: ["left", "center", "right"].map((a) => ({ value: `text-${a}`, label: a })),
};

const SPACES = ["0", "1", "2", "3", "4", "6", "8", "10", "12", "16", "20", "24"];

export const PADDING: StyleGroup = {
  id: "padding",
  label: "Padding",
  matches: (cls) => /^p-(\d+(\.\d+)?|px|\[[^\]]+\])$/.test(cls),
  options: [{ value: "", label: "default" }, ...SPACES.map((s) => ({ value: `p-${s}`, label: s }))],
};

export const MARGIN_Y: StyleGroup = {
  id: "margin-y",
  label: "Space above and below",
  matches: (cls) => /^my-(\d+(\.\d+)?|px|auto|\[[^\]]+\])$/.test(cls),
  options: [
    { value: "", label: "default" },
    ...SPACES.map((s) => ({ value: `my-${s}`, label: s })),
  ],
};

export const RADIUS: StyleGroup = {
  id: "radius",
  label: "Corners",
  matches: (cls) => /^rounded(-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/.test(cls),
  options: ["none", "sm", "md", "lg", "xl", "2xl", "full"].map((r) => ({
    value: `rounded-${r}`,
    label: r,
  })),
};

export const SHADOW: StyleGroup = {
  id: "shadow",
  label: "Shadow",
  matches: (cls) => /^shadow(-(none|2xs|xs|sm|md|lg|xl|2xl))?$/.test(cls),
  options: ["none", "sm", "md", "lg", "xl"].map((s) => ({ value: `shadow-${s}`, label: s })),
};

export const OPACITY: StyleGroup = {
  id: "opacity",
  label: "See-through",
  matches: (cls) => /^opacity-\d{1,3}$/.test(cls),
  options: [
    { value: "", label: "solid" },
    ...["90", "75", "50", "25"].map((o) => ({ value: `opacity-${o}`, label: `${o}%` })),
  ],
};

/** The groups shown for an element: text styles only where there is text. */
export function groupsFor(item: { text: string | null; tag: string }): StyleGroup[] {
  const textual = item.text !== null || /^(h[1-6]|p|span|a|button|li|label)$/.test(item.tag);
  const box = [BACKGROUND, PADDING, MARGIN_Y, RADIUS, SHADOW, OPACITY];
  return textual ? [TEXT_COLOR, TEXT_SIZE, WEIGHT, ALIGNMENT, ...box] : box;
}

const tokens = (className: string) => className.split(/\s+/).filter(Boolean);

/** The group's current class in `className` (unprefixed only), or "". */
export function currentOf(className: string, group: StyleGroup): string {
  return tokens(className).find((cls) => group.matches(cls)) ?? "";
}

/**
 * `className` with the group's unprefixed class set to `value` ("" removes it). A new class
 * goes where the old one was, or at the end.
 */
export function setGroup(className: string, group: StyleGroup, value: string): string {
  const list = tokens(className);
  const at = list.findIndex((cls) => group.matches(cls));
  const rest = list.filter((cls) => !group.matches(cls));
  if (!value) return rest.join(" ");
  if (at < 0) return [...rest, value].join(" ");
  rest.splice(Math.min(at, rest.length), 0, value);
  return rest.join(" ");
}
