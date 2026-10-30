import { type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import type { GhlHttp } from "./ghl-oauth.ts";

/**
 * How a sub-account is set up in GoHighLevel, by name: what it sells, how it books, how its
 * deals move, the fields it keeps and the forms and workflows it runs. Read once when an
 * agency picks its main sub-account, for a starter note in its brain. Names only: never a
 * contact, message, invoice or anything about one customer.
 */
export interface SetupSummary {
  products: string[];
  calendars: string[];
  pipelines: { name: string; stages: string[] }[];
  customFields: string[];
  forms: string[];
  workflows: string[];
  /** Parts GoHighLevel didn't give (a scope Locus lacks, or an error), by their heading. */
  unread: string[];
}

/** How many parts the summary reads. */
export const SETUP_PARTS = 6;

/** Most names kept from each part. A sub-account with more is summed up, not listed. */
export const MAX_SETUP_NAMES = 50;

/** Longest name kept, in characters. */
const MAX_NAME_CHARS = 100;

/**
 * A name as one plain line: GoHighLevel names are typed by the client's staff, so they lose line
 * breaks, control characters and anything Markdown could read as a heading or list, and are cut
 * to a sensible length.
 */
export function plainName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = raw
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#>*+\-\s]+/, "");
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 1)}…` : flat;
}

type Named = { name?: unknown };
const names = (items: Named[] | undefined): string[] =>
  (items ?? [])
    .map((i) => plainName(i.name))
    .filter(Boolean)
    .slice(0, MAX_SETUP_NAMES);

export async function readSetupSummary(
  session: GhlSession,
  http: GhlHttp = {},
): Promise<SetupSummary> {
  const unread: string[] = [];
  const read = async <T>(label: string, id: string, pick: (res: T) => unknown[]) => {
    const op = operationById(id);
    try {
      if (!op) throw new Error(`The skill catalog is missing ${id}`);
      // Paged lists: ask for as many as the note keeps, not GoHighLevel's default page.
      const paging = op.pagination;
      const query =
        paging?.style === "offset" && paging.in === "query"
          ? { [paging.limit]: MAX_SETUP_NAMES }
          : undefined;
      return pick(await ghlRequest<T>(op, session, query ? { query } : {}, http));
    } catch (error) {
      // A scope the app lacks reads the same as GoHighLevel failing; the log tells them apart.
      console.warn(`Reading ${label} for the setup note failed`, error);
      unread.push(label);
      return [];
    }
  };
  const [products, calendars, pipelines, customFields, forms, workflows] = await Promise.all([
    read<{ products?: Named[] }>("Products", "products.list-invoices", (r) => names(r.products)),
    read<{ calendars?: Named[] }>("Calendars", "calendars.get-calendars", (r) =>
      names(r.calendars),
    ),
    read<{ pipelines?: (Named & { stages?: Named[] })[] }>(
      "Pipelines",
      "opportunities.get-pipelines",
      (r) =>
        (r.pipelines ?? [])
          .filter((p) => typeof p.name === "string" && p.name.trim())
          .slice(0, MAX_SETUP_NAMES)
          .map((p) => ({ name: String(p.name).trim(), stages: names(p.stages) })),
    ),
    read<{ customFields?: Named[] }>("Custom fields", "locations.get-custom-fields", (r) =>
      names(r.customFields),
    ),
    read<{ forms?: Named[] }>("Forms", "forms.get-forms", (r) => names(r.forms)),
    read<{ workflows?: Named[] }>("Workflows", "workflows.get-workflow", (r) => names(r.workflows)),
  ]);
  return {
    products: products as string[],
    calendars: calendars as string[],
    pipelines: pipelines as SetupSummary["pipelines"],
    customFields: customFields as string[],
    forms: forms as string[],
    workflows: workflows as string[],
    unread,
  };
}

/** The summary as a brain note, dated, saying where it came from and that it can go stale. */
export function setupNote(summary: SetupSummary, business: string, on: Date): string {
  const day = on.toISOString().slice(0, 10);
  const list = (heading: string, items: string[]) =>
    summary.unread.includes(heading)
      ? []
      : [
          `## ${heading}`,
          "",
          ...(items.length ? items.map((i) => `- ${i}`) : ["None set up yet."]),
          ...(items.length >= MAX_SETUP_NAMES
            ? [`(The first ${MAX_SETUP_NAMES}; there may be more.)`]
            : []),
          "",
        ];
  const pipelines = summary.unread.includes("Pipelines")
    ? []
    : [
        "## Pipelines",
        "",
        ...(summary.pipelines.length
          ? summary.pipelines.map(
              (p) => `- ${p.name}${p.stages.length ? `: ${p.stages.join(" → ")}` : ""}`,
            )
          : ["None set up yet."]),
        "",
      ];
  return [
    `# How ${plainName(business) || "this sub-account"} is set up in GoHighLevel`,
    "",
    `Read from GoHighLevel on ${day}, when Locus was set up. It's a starting point and goes stale:`,
    "GoHighLevel itself is always right, so check there before relying on a detail.",
    "",
    ...list("Products", summary.products),
    ...list("Calendars", summary.calendars),
    ...pipelines,
    ...list("Custom fields", summary.customFields),
    ...list("Forms", summary.forms),
    ...list("Workflows", summary.workflows),
    ...(summary.unread.length
      ? [`Not read (Locus couldn't see them): ${summary.unread.join(", ")}.`, ""]
      : []),
  ].join("\n");
}
