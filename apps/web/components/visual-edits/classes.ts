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

/** An arbitrary value (`[...]`) that is a colour, not a size, image or position. */
const ARBITRARY_COLOR =
  /^\[(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb|color)\(.*\)|color:.*|var\(--color.*\))\]$/i;

/** Utilities that share a colour's prefix but aren't colours. */
const NOT_COLOR: Record<string, RegExp> = {
  text: /^text-(shadow(-.*)?|ellipsis|clip|wrap|nowrap|balance|pretty)$/,
  bg: /^bg-(none|gradient.*|linear.*|radial.*|conic.*|clip-.*|origin-.*|fixed|local|scroll|auto|cover|contain|repeat.*|no-repeat|space|round|blend-.*|size-.*|position-.*|top.*|bottom.*|left.*|right.*|center|inherit|current|transparent)$/,
};

const colorOf = (prefix: "text" | "bg") => (cls: string) => {
  if (!cls.startsWith(`${prefix}-`)) return false;
  const rest = cls.slice(prefix.length + 1);
  if (prefix === "text" && (SIZES.includes(rest) || ALIGN.includes(rest))) return false;
  if (prefix === "text" && TEXT_UTILITIES.includes(rest)) return false;
  if (NOT_COLOR[prefix]?.test(cls)) return false;
  const value = rest.replace(/\/(\d{1,3}|\[[^\]]+\])$/, "");
  if (value.startsWith("[")) return ARBITRARY_COLOR.test(value);
  return /^[a-z]+(-[a-z]+)*(-\d{2,3})?$/.test(value);
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

/** Tailwind's own values for the fixed colours the editor offers. */
const PALETTE_VALUES: Record<string, string> = {
  white: "#fff",
  black: "#000",
  "slate-900": "oklch(20.8% 0.042 265.755)",
  "slate-500": "oklch(55.4% 0.046 257.417)",
  "red-600": "oklch(57.7% 0.245 27.325)",
  "orange-500": "oklch(70.5% 0.213 47.604)",
  "amber-400": "oklch(82.8% 0.189 84.429)",
  "green-600": "oklch(62.7% 0.194 149.214)",
  "teal-600": "oklch(60% 0.118 184.704)",
  "sky-500": "oklch(68.5% 0.169 237.323)",
  "blue-600": "oklch(54.6% 0.245 262.881)",
  "indigo-600": "oklch(51.1% 0.262 276.966)",
  "purple-600": "oklch(55.8% 0.291 302.321)",
  "pink-600": "oklch(59.2% 0.249 0.584)",
};

const colorValue = (c: string) => PALETTE_VALUES[c] ?? `var(--${c})`;

const SIZE_VALUES: Record<string, [string, string]> = {
  xs: ["0.75rem", "calc(1 / 0.75)"],
  sm: ["0.875rem", "calc(1.25 / 0.875)"],
  base: ["1rem", "1.5"],
  lg: ["1.125rem", "calc(1.75 / 1.125)"],
  xl: ["1.25rem", "calc(1.75 / 1.25)"],
  "2xl": ["1.5rem", "calc(2 / 1.5)"],
  "3xl": ["1.875rem", "1.2"],
  "4xl": ["2.25rem", "calc(2.5 / 2.25)"],
  "5xl": ["3rem", "1"],
  "6xl": ["3.75rem", "1"],
  "7xl": ["4.5rem", "1"],
};

const WEIGHTS: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

// The site's shadcn theme sets corners from `--radius`, as its globals.css does.
const RADII: Record<string, string> = {
  none: "0",
  sm: "calc(var(--radius, 0.625rem) * 0.6)",
  md: "calc(var(--radius, 0.625rem) * 0.8)",
  lg: "var(--radius, 0.625rem)",
  xl: "calc(var(--radius, 0.625rem) * 1.4)",
  "2xl": "calc(var(--radius, 0.625rem) * 1.8)",
  full: "9999px",
};

const SHADOWS: Record<string, string> = {
  none: "0 0 #0000",
  sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
};

const space = (n: string) => `${Number(n) * 0.25}rem`;

/** The CSS for one of the editor's own classes, or null for a class it doesn't offer. */
function declarationsOf(cls: string): string | null {
  const dash = cls.indexOf("-");
  const prefix = cls.slice(0, dash);
  const v = cls.slice(dash + 1);
  switch (prefix) {
    case "text": {
      const size = SIZE_VALUES[v];
      if (size) return `font-size:${size[0]};line-height:${size[1]}`;
      if (ALIGN.includes(v)) return `text-align:${v}`;
      return `color:${colorValue(v)}`;
    }
    case "bg":
      return `background-color:${colorValue(v)}`;
    case "font":
      return v in WEIGHTS ? `font-weight:${WEIGHTS[v]}` : null;
    case "p":
      return `padding:${space(v)}`;
    case "my":
      return `margin-block:${space(v)}`;
    case "rounded":
      return v in RADII ? `border-radius:${RADII[v]}` : null;
    case "shadow":
      return v in SHADOWS ? `box-shadow:${SHADOWS[v]}` : null;
    case "opacity":
      return `opacity:${Number(v) / 100}`;
    default:
      return null;
  }
}

/**
 * Rules for every class the style controls offer, so a change shows in the preview at once:
 * the site's built CSS only holds the classes its pages already used. They sit in Tailwind's
 * utilities layer with no specificity (`:where`), so the site's own rules, and its responsive
 * and hover variants, still win wherever they apply, as they will once the change is saved.
 */
export function previewCss(): string {
  const groups = [
    TEXT_COLOR,
    BACKGROUND,
    TEXT_SIZE,
    WEIGHT,
    ALIGNMENT,
    PADDING,
    MARGIN_Y,
    RADIUS,
    SHADOW,
    OPACITY,
  ];
  const rules = groups.flatMap((g) =>
    g.options
      .map((o) => o.value)
      .filter(Boolean)
      .map((cls) => {
        const css = declarationsOf(cls);
        return css ? `:where(.${cls}){${css}}` : "";
      })
      .filter(Boolean),
  );
  return `@layer utilities{${rules.join("")}}`;
}
