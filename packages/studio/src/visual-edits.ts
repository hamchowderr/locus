import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { z } from "zod";
import { SOURCE_ATTR } from "./visual-edits-protocol.ts";
import type { SiteFile } from "./workspace.ts";

/**
 * Visual edits: changing a site by clicking things in its live preview, without the AI.
 *
 * The preview's copy of each page and component carries a `data-locus-src="<path>:<offset>"`
 * attribute on every JSX element (`annotateSource`), naming where that element starts in the
 * draft. A click in the preview reports that location, and `applyVisualEdits` changes the
 * element's text or one of its attributes right there in the source. Text that comes from data
 * (a list in `lib/`, `lib/site.ts`) is found by its value instead, when exactly one string in
 * the site holds it. Only the preview is annotated: the draft, its versions and published
 * sites never carry the attribute.
 */
export { SOURCE_ATTR } from "./visual-edits-protocol.ts";

/** Elements that never get a location: nothing in them can be clicked. */
const SKIPPED_ELEMENTS = new Set(["html", "head", "script", "style", "Fragment"]);

const SOURCE_FILE = /\.(tsx|jsx)$/;
const CODE_FILE = /\.(tsx|jsx|ts|js|mjs)$/;

/**
 * Whether the preview annotates this file. shadcn's own `components/ui` are left alone, so a
 * `<Button>` reports where the page uses it (its text and link are there), not the component.
 */
export function isAnnotatable(path: string): boolean {
  return SOURCE_FILE.test(path) && !path.startsWith("components/ui/");
}

type AnyNode = Node & { start: number; end: number };

function parseCode(code: string) {
  return parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
}

/** Every node under `root`, each with its parent, depth first in source order. */
function* walk(root: Node, parent: Node | null = null): Generator<[AnyNode, Node | null]> {
  yield [root as AnyNode, parent];
  for (const key of Object.keys(root)) {
    if (key === "loc" || key === "extra" || key === "leadingComments") continue;
    if (key === "trailingComments" || key === "innerComments") continue;
    const value = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) yield* walk(child, root);
      }
    } else if (isNode(value)) {
      yield* walk(value, root);
    }
  }
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function elementName(name: Node): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property.name;
  if (name.type === "JSXNamespacedName") return name.name.name;
  return "";
}

function hasAttribute(attributes: Node[], attr: string): boolean {
  return attributes.some(
    (a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === attr,
  );
}

/**
 * The preview's copy of a page or component: every JSX element gets `data-locus-src`. The
 * attribute goes on the opening tag's own line, so line numbers in errors stay right. A file
 * that doesn't parse is left as it is (the dev server shows its error anyway).
 */
export function annotateSource(path: string, code: string): string {
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(code);
  } catch {
    return code;
  }
  const inserts: { at: number; text: string }[] = [];
  for (const [node] of walk(ast.program)) {
    if (node.type !== "JSXOpeningElement") continue;
    if (SKIPPED_ELEMENTS.has(elementName(node.name))) continue;
    if (hasAttribute(node.attributes, SOURCE_ATTR)) continue;
    const after = (node.typeArguments ?? node.name) as AnyNode;
    inserts.push({ at: after.end, text: ` ${SOURCE_ATTR}="${path}:${node.start}"` });
  }
  let out = code;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at);
  }
  return out;
}

const Target = z
  .string()
  .max(600)
  .regex(/^[^:"]+:\d+$/, "Not a preview location");

const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/|#|\?|\.{0,2}\/?[\w-])/i;
const UNSAFE_SCHEME = /^\s*(javascript|data|vbscript|file):/i;
const safeUrl = (v: string) => v === "" || (SAFE_URL.test(v) && !UNSAFE_SCHEME.test(v));

/** One change made in the preview. `from` is what the preview showed when it was made. */
export const VisualEdit = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    target: Target,
    from: z.string().max(10_000),
    to: z.string().max(10_000),
  }),
  z.object({
    kind: z.literal("attr"),
    target: Target,
    name: z.enum(["src", "alt", "href", "className", "placeholder"]),
    from: z.string().max(10_000).nullable(),
    to: z.string().max(10_000),
  }),
  z.object({
    kind: z.literal("newTab"),
    target: Target,
    on: z.boolean(),
  }),
]);
export type VisualEdit = z.infer<typeof VisualEdit>;

export const VisualEdits = z.array(VisualEdit).min(1).max(200);

export interface VisualEditFailure {
  /** Index into the edits given. */
  index: number;
  reason: string;
}

export interface VisualEditResult {
  /** The files that changed, with their new content. */
  files: SiteFile[];
  applied: number;
  failed: VisualEditFailure[];
}

const STALE =
  "This part of the page changed since it was selected. Reload the preview and try again.";
const ASK_CHAT = "Ask the chat to change this one.";

class EditRefused extends Error {}

interface Splice {
  start: number;
  end: number;
  text: string;
}

interface ParsedFile {
  code: string;
  ast: ReturnType<typeof parseCode> | null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text as JSX children: plain when it can be, else a string expression. */
function jsxText(value: string): string {
  if (value === "" || /[{}<>&\n]/.test(value) || value !== value.trim()) {
    return `{${JSON.stringify(value)}}`;
  }
  return value;
}

/** A JSX attribute value: a plain string when that reads back exactly, else an expression. */
function attrValue(value: string): string {
  return /^[^"\\&\n{}]*$/.test(value) ? `"${value}"` : `{${JSON.stringify(value)}}`;
}

/** A string literal (or a template with no `${}`) and its value; null for anything else. */
function literalValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Applies edits made in the preview to the site's files (the draft's snapshot). Each edit
 * either applies whole or is refused with a reason a person can read; the rest still apply.
 * Returns only the files that changed.
 */
export function applyVisualEdits(snapshot: SiteFile[], edits: VisualEdit[]): VisualEditResult {
  const parsed = new Map<string, ParsedFile>();
  const textOf = (path: string): ParsedFile | null => {
    const known = parsed.get(path);
    if (known) return known;
    const file = snapshot.find((f) => f.path === path);
    if (!file || typeof file.content !== "string") return null;
    let ast: ParsedFile["ast"] = null;
    try {
      ast = parseCode(file.content);
    } catch {
      ast = null;
    }
    const entry = { code: file.content, ast };
    parsed.set(path, entry);
    return entry;
  };

  const splices = new Map<string, Splice[]>();
  const failed: VisualEditFailure[] = [];
  let applied = 0;

  edits.forEach((edit, index) => {
    try {
      const planned = planEdit(edit, textOf, snapshot);
      for (const [path, splice] of planned) {
        const existing = splices.get(path) ?? [];
        if (existing.some((s) => s.start < splice.end && splice.start < s.end)) {
          throw new EditRefused("Another change in this save already touches the same spot.");
        }
      }
      for (const [path, splice] of planned) {
        splices.set(path, [...(splices.get(path) ?? []), splice]);
      }
      applied++;
    } catch (error) {
      if (!(error instanceof EditRefused)) throw error;
      failed.push({ index, reason: error.message });
    }
  });

  const files: SiteFile[] = [];
  for (const [path, list] of splices) {
    const source = parsed.get(path);
    if (!source) continue;
    let code = source.code;
    for (const s of [...list].sort((a, b) => b.start - a.start)) {
      code = code.slice(0, s.start) + s.text + code.slice(s.end);
    }
    files.push({ path, content: code });
  }
  return { files, applied, failed };
}

type Lookup = (path: string) => ParsedFile | null;

function planEdit(edit: VisualEdit, textOf: Lookup, snapshot: SiteFile[]): [string, Splice][] {
  const at = edit.target.lastIndexOf(":");
  const path = edit.target.slice(0, at);
  const offset = Number(edit.target.slice(at + 1));
  const file = textOf(path);
  if (!file) throw new EditRefused(STALE);
  if (!file.ast) throw new EditRefused(`This file has an error in it right now. ${ASK_CHAT}`);
  const element = elementAt(file.ast.program, offset);
  if (!element) throw new EditRefused(STALE);
  const one = (splice: Splice): [string, Splice][] => [[path, splice]];

  if (edit.kind === "text") {
    const children = element.children.filter(
      (c) => !(c.type === "JSXText" && c.value.trim() === ""),
    );
    const [only] = children;
    if (children.length === 1 && only?.type === "JSXText") {
      const child = only as AnyNode & { value: string };
      if (norm(child.value) !== norm(edit.from)) throw new EditRefused(STALE);
      const raw = file.code.slice(child.start, child.end);
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      return one({
        start: child.start + lead,
        end: child.end - trail,
        text: jsxText(edit.to),
      });
    }
    if (children.length === 1 && only?.type === "JSXExpressionContainer") {
      const expression = only.expression as AnyNode;
      const value = literalValue(expression);
      if (value !== null) {
        if (norm(value) !== norm(edit.from)) throw new EditRefused(STALE);
        return one({ start: expression.start, end: expression.end, text: JSON.stringify(edit.to) });
      }
    }
    if (children.some((c) => c.type === "JSXElement" || c.type === "JSXFragment")) {
      throw new EditRefused(`This text has other parts of the page inside it. ${ASK_CHAT}`);
    }
    // The text comes from data: change the one string in the site that holds it.
    return [findLiteral(edit.from, edit.to, textOf, snapshot, true)];
  }

  const attributes = element.openingElement.attributes;
  const named = (name: string) =>
    attributes.find(
      (a): a is Extract<(typeof attributes)[number], { type: "JSXAttribute" }> =>
        a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name,
    ) as (AnyNode & { value: Node | null }) | undefined;
  const nameEnd = ((element.openingElement.typeArguments ?? element.openingElement.name) as AnyNode)
    .end;

  if (edit.kind === "newTab") {
    const target = named("target");
    const rel = named("rel");
    if (edit.on) {
      if (!target && !rel) {
        return one({
          start: nameEnd,
          end: nameEnd,
          text: ' target="_blank" rel="noopener noreferrer"',
        });
      }
      const out = [setAttr(path, target, "target", "_blank", nameEnd)];
      if (!rel)
        out.push([path, { start: nameEnd, end: nameEnd, text: ' rel="noopener noreferrer"' }]);
      return out;
    }
    const out: [string, Splice][] = [];
    for (const attr of [target, rel]) {
      if (!attr) continue;
      if (attr.value && attr.value.type !== "StringLiteral") {
        throw new EditRefused(`This link's settings are set in code. ${ASK_CHAT}`);
      }
      out.push([path, { start: precedingSpace(file.code, attr.start), end: attr.end, text: "" }]);
    }
    return out;
  }

  if ((edit.name === "href" || edit.name === "src") && !safeUrl(edit.to.trim())) {
    throw new EditRefused("That link isn't one a site can use.");
  }
  const attr = named(edit.name);
  if (!attr) {
    if (edit.from) throw new EditRefused(STALE);
    return [[path, { start: nameEnd, end: nameEnd, text: ` ${edit.name}=${attrValue(edit.to)}` }]];
  }
  const value = attrNode(attr.value);
  const current = literalValue(value);
  if (current !== null && value) {
    if (edit.from !== null && current !== edit.from) {
      if (!(edit.name === "className" && norm(current) === norm(edit.from))) {
        throw new EditRefused(STALE);
      }
    }
    // Replace the whole value (quotes or braces included).
    const node = attr.value as AnyNode;
    return [[path, { start: node.start, end: node.end, text: attrValue(edit.to) }]];
  }
  if (edit.name === "className") {
    throw new EditRefused(`This item's styles are worked out in code. ${ASK_CHAT}`);
  }
  if (!edit.from) throw new EditRefused(ASK_CHAT);
  // The value comes from data (e.g. `src={hero.image}`): change the string that holds it.
  return [findLiteral(edit.from, edit.to, textOf, snapshot, false)];
}

function attrNode(value: Node | null): Node | null {
  if (!value) return null;
  if (value.type === "JSXExpressionContainer") return value.expression as Node;
  return value;
}

function setAttr(
  path: string,
  attr: (AnyNode & { value: Node | null }) | undefined,
  name: string,
  to: string,
  nameEnd: number,
): [string, Splice] {
  if (!attr) return [path, { start: nameEnd, end: nameEnd, text: ` ${name}=${attrValue(to)}` }];
  if (attr.value && literalValue(attrNode(attr.value)) === null) {
    throw new EditRefused(`This link's settings are set in code. ${ASK_CHAT}`);
  }
  return [path, { start: attr.start, end: attr.end, text: `${name}=${attrValue(to)}` }];
}

function precedingSpace(code: string, start: number): number {
  let i = start;
  while (i > 0 && /[ \t]/.test(code[i - 1] ?? "")) i--;
  return i;
}

type JSXElementNode = Extract<Node, { type: "JSXElement" }> & AnyNode;

function elementAt(program: Node, offset: number): JSXElementNode | null {
  for (const [node] of walk(program)) {
    if (node.type === "JSXElement" && node.openingElement.start === offset) {
      return node as JSXElementNode;
    }
  }
  return null;
}

/**
 * The one string in the site's code whose value is `from`, as a splice that sets it to `to`.
 * `asText` compares the way the page shows text (spaces collapsed). Import paths, object keys,
 * attribute values and type names never count, nor do shadcn's own components.
 */
function findLiteral(
  from: string,
  to: string,
  textOf: Lookup,
  snapshot: SiteFile[],
  asText: boolean,
): [string, Splice] {
  const want = asText ? norm(from) : from;
  if (!want) throw new EditRefused(ASK_CHAT);
  const matches: { path: string; node: AnyNode; jsx: boolean }[] = [];
  for (const file of snapshot) {
    if (!CODE_FILE.test(file.path) || typeof file.content !== "string") continue;
    if (file.path.startsWith("components/ui/")) continue;
    const probe = asText ? (want.split(" ")[0] ?? want) : want;
    if (!file.content.includes(probe)) continue;
    const parsed = textOf(file.path);
    if (!parsed?.ast) continue;
    for (const [node, parent] of walk(parsed.ast.program)) {
      if (!parent) continue;
      if (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration") continue;
      if (parent.type === "ExportAllDeclaration" || parent.type === "TSLiteralType") continue;
      if (parent.type === "ObjectProperty" && parent.key === node) continue;
      if (parent.type === "JSXAttribute") continue;
      if (node.type === "JSXText") {
        if (asText && norm(node.value) === want) matches.push({ path: file.path, node, jsx: true });
        continue;
      }
      const literal = literalValue(node);
      if (literal !== null && (asText ? norm(literal) : literal) === want) {
        matches.push({ path: file.path, node, jsx: false });
      }
    }
  }
  if (matches.length === 0) {
    throw new EditRefused(`Couldn't find where this comes from in the site. ${ASK_CHAT}`);
  }
  if (matches.length > 1) {
    throw new EditRefused(`This is used in more than one place on the site. ${ASK_CHAT}`);
  }
  const [match] = matches as [(typeof matches)[number]];
  if (!match.jsx) {
    return [match.path, { start: match.node.start, end: match.node.end, text: JSON.stringify(to) }];
  }
  const code = textOf(match.path)?.code ?? "";
  const raw = code.slice(match.node.start, match.node.end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  return [
    match.path,
    { start: match.node.start + lead, end: match.node.end - trail, text: jsxText(to) },
  ];
}
