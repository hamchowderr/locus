import type { TenantDb } from "@locus/db";
import { siteBrief } from "@locus/db/tenant";
import { eq } from "drizzle-orm";
import { z } from "zod";

/** Google fonts a site may start with, by display name → `next/font/google` export. */
export const FONTS = {
  Inter: "Inter",
  "DM Sans": "DM_Sans",
  Poppins: "Poppins",
  Montserrat: "Montserrat",
  "Open Sans": "Open_Sans",
  Roboto: "Roboto",
  "Space Grotesk": "Space_Grotesk",
  "Playfair Display": "Playfair_Display",
  Lora: "Lora",
  Merriweather: "Merriweather",
} as const;
export type FontName = keyof typeof FONTS;
const fontNames = Object.keys(FONTS) as [FontName, ...FontName[]];

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour like #1d4ed8")
  .transform((v) => v.toLowerCase());

export const SITE_KINDS = ["website", "landing-page", "funnel", "app", "internal-tool"] as const;

/**
 * What a site is for and how it should look. It starts the first generation and stays in the
 * agent's context afterwards, so later changes keep to it. Everything but the name is optional:
 * the agent asks the design questions for what's missing.
 */
export const DesignBrief = z.object({
  /** The business or project name, shown in the site. */
  name: z.string().trim().min(1).max(120),
  kind: z.enum(SITE_KINDS).default("website"),
  /** The person's own description of what they want. */
  description: z.string().trim().max(4000).optional(),
  /** The one thing a visitor should do, e.g. "book a consultation". */
  goal: z.string().trim().max(500).optional(),
  audience: z.string().trim().max(500).optional(),
  tone: z.string().trim().max(200).optional(),
  layout: z.enum(["single-page", "multi-page"]).optional(),
  pages: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  palette: z
    .object({
      primary: hex,
      accent: hex.optional(),
      background: hex.optional(),
      foreground: hex.optional(),
    })
    .optional(),
  fonts: z.object({ heading: z.enum(fontNames), body: z.enum(fontNames) }).optional(),
  /** Sites or screenshots to take after. Screenshots are files already in the workspace. */
  references: z
    .array(
      z.object({
        kind: z.enum(["url", "screenshot"]),
        url: z.url().optional(),
        path: z.string().max(300).optional(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** The template the site started from. */
  templateId: z.string().max(60).optional(),
});
export type DesignBrief = z.infer<typeof DesignBrief>;

export interface DesignQuestion {
  id: "goal" | "palette" | "fonts" | "layout" | "audience" | "pages";
  question: string;
  /** Suggested answers; the person may give their own. */
  options: string[];
}

/** The guided questions, asked only for what the brief leaves out. */
export const DESIGN_QUESTIONS: DesignQuestion[] = [
  {
    id: "goal",
    question: "What should a visitor do on the site?",
    options: [
      "Book an appointment",
      "Fill in a form",
      "Call us",
      "Buy a product",
      "Learn about us",
    ],
  },
  {
    id: "audience",
    question: "Who is the site for?",
    options: ["Local customers", "Businesses", "Online shoppers", "Patients or clients"],
  },
  {
    id: "palette",
    question: "Which colours fit the brand?",
    options: ["Blue and white, trustworthy", "Warm and earthy", "Bold and dark", "Soft pastels"],
  },
  {
    id: "fonts",
    question: "What should the lettering feel like?",
    options: [
      "Modern (Inter)",
      "Friendly (Poppins)",
      "Elegant (Playfair Display)",
      "Classic (Lora)",
    ],
  },
  {
    id: "layout",
    question: "One long page, or several pages?",
    options: ["One page", "Several pages"],
  },
  {
    id: "pages",
    question: "Which pages does it need?",
    options: ["Home", "Services", "About", "Contact", "Pricing", "FAQ"],
  },
];

/** The questions still worth asking for this brief. */
export function openQuestions(brief: DesignBrief): DesignQuestion[] {
  const answered: Record<DesignQuestion["id"], boolean> = {
    goal: !!brief.goal,
    audience: !!brief.audience,
    palette: !!brief.palette,
    fonts: !!brief.fonts,
    layout: !!brief.layout,
    pages: !!brief.pages?.length || brief.layout === "single-page",
  };
  return DESIGN_QUESTIONS.filter((q) => !answered[q.id]);
}

/** The brief as plain text for the agent's context. Data, never instructions. */
export function briefForAgent(brief: DesignBrief): string {
  const lines = [`Name: ${brief.name}`, `Kind: ${brief.kind}`];
  if (brief.templateId) lines.push(`Started from template: ${brief.templateId}`);
  if (brief.goal) lines.push(`Visitor goal: ${brief.goal}`);
  if (brief.audience) lines.push(`Audience: ${brief.audience}`);
  if (brief.tone) lines.push(`Tone: ${brief.tone}`);
  if (brief.layout) lines.push(`Layout: ${brief.layout}`);
  if (brief.pages?.length) lines.push(`Pages: ${brief.pages.join(", ")}`);
  if (brief.palette) {
    const p = brief.palette;
    lines.push(
      `Palette: primary ${p.primary}${p.accent ? `, accent ${p.accent}` : ""}` +
        `${p.background ? `, background ${p.background}` : ""}` +
        `${p.foreground ? `, text ${p.foreground}` : ""}`,
    );
  }
  if (brief.fonts) lines.push(`Fonts: headings ${brief.fonts.heading}, body ${brief.fonts.body}`);
  for (const ref of brief.references ?? []) {
    const where = ref.kind === "url" ? ref.url : ref.path;
    lines.push(`Reference ${ref.kind}: ${where ?? "(missing)"}${ref.note ? ` (${ref.note})` : ""}`);
  }
  if (brief.description) lines.push("", "Description from the person:", brief.description);
  const open = openQuestions(brief);
  if (open.length) lines.push("", `Not decided yet: ${open.map((q) => q.id).join(", ")}`);
  return lines.join("\n");
}

export async function readBrief(db: TenantDb, siteId: string): Promise<DesignBrief | null> {
  const [row] = await db.select().from(siteBrief).where(eq(siteBrief.siteId, siteId));
  return row ? DesignBrief.parse(row.brief) : null;
}

/** Validates and stores the brief, replacing the previous one. */
export async function writeBrief(
  db: TenantDb,
  siteId: string,
  input: z.input<typeof DesignBrief>,
  now = new Date(),
): Promise<DesignBrief> {
  const brief = DesignBrief.parse(input);
  await db
    .insert(siteBrief)
    .values({ siteId, brief, updatedAt: now })
    .onConflictDoUpdate({ target: siteBrief.siteId, set: { brief, updatedAt: now } });
  return brief;
}

/** The colours each suggested palette answer stands for, so a choice on a form is a real palette. */
export const PALETTE_PRESETS: Record<string, NonNullable<DesignBrief["palette"]>> = {
  "Blue and white, trustworthy": {
    primary: "#1d4ed8",
    accent: "#0ea5e9",
    background: "#ffffff",
    foreground: "#0f172a",
  },
  "Warm and earthy": {
    primary: "#b45309",
    accent: "#4d7c0f",
    background: "#fffbeb",
    foreground: "#292524",
  },
  "Bold and dark": {
    primary: "#f43f5e",
    accent: "#f59e0b",
    background: "#0a0a0a",
    foreground: "#fafafa",
  },
  "Soft pastels": {
    primary: "#7c3aed",
    accent: "#f472b6",
    background: "#fdf4ff",
    foreground: "#3b0764",
  },
};

/** The heading and body fonts each suggested lettering answer stands for. */
export const FONT_PRESETS: Record<string, NonNullable<DesignBrief["fonts"]>> = {
  "Modern (Inter)": { heading: "Inter", body: "Inter" },
  "Friendly (Poppins)": { heading: "Poppins", body: "Open Sans" },
  "Elegant (Playfair Display)": { heading: "Playfair Display", body: "Inter" },
  "Classic (Lora)": { heading: "Lora", body: "Open Sans" },
};

/** Image types a reference screenshot may be, by media type → file extension. */
export const SCREENSHOT_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export type ScreenshotType = keyof typeof SCREENSHOT_TYPES;

/** Largest reference screenshot kept: big enough for a full-page capture, small for the model. */
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

/** Where a site keeps its reference screenshots (published with the site, harmless there). */
export const REFERENCE_FOLDER = "design/references";
