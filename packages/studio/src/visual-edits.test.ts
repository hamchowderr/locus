import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATES } from "./templates/index.ts";
import {
  annotateSource,
  applyVisualEdits,
  isAnnotatable,
  SOURCE_ATTR,
  type VisualEdit,
  VisualEdits,
} from "./visual-edits.ts";
import {
  previewFiles,
  VISUAL_EDITS_SCRIPT,
  VISUAL_EDITS_SCRIPT_PATH,
} from "./visual-edits-preview.ts";
import type { SiteFile } from "./workspace.ts";

const parses = (code: string) =>
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

const PAGE = `import { services } from "@/lib/services";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto p-6">
      <h1 className="text-4xl font-bold">Bright Smiles Dental</h1>
      <p>{"Gentle care for the whole family."}</p>
      <img src="/hero.jpg" alt="Our office" className="rounded" />
      <a href="/contact">Book a visit</a>
      <Button asChild>
        <a href="https://example.com" target="_blank" rel="noopener noreferrer">
          Call us
        </a>
      </Button>
      <p className={cn("text-sm", big && "text-lg")}>Small print</p>
      <p>
        Open <strong>today</strong>
      </p>
      <ul>
        {services.map((s) => (
          <li key={s.name}>{s.name}</li>
        ))}
      </ul>
      <p>{site.phone}</p>
    </main>
  );
}
`;

const SERVICES = `export const services = [
  { name: "Cleaning", image: "/cleaning.jpg" },
  { name: "Whitening", image: "/whitening.jpg" },
];
`;

const SITE = `export const site = { name: "Bright Smiles", phone: "555-0100", fax: "555-0100" };
`;

const files = (): SiteFile[] => [
  { path: "app/page.tsx", content: PAGE },
  { path: "lib/services.ts", content: SERVICES },
  { path: "lib/site.ts", content: SITE },
];

/** The preview location of the first element whose opening tag starts with `tag`. */
function target(code: string, tag: string, path = "app/page.tsx", nth = 0): string {
  let from = -1;
  for (let i = 0; i <= nth; i++) {
    from = code.indexOf(tag, from + 1);
    if (from < 0) throw new Error(`no ${tag}`);
  }
  return `${path}:${from}`;
}

const contentOf = (result: ReturnType<typeof applyVisualEdits>, path: string) =>
  result.files.find((f) => f.path === path)?.content as string | undefined;

describe("annotateSource", () => {
  it("marks every element with where it starts, keeping lines and code valid", () => {
    const out = annotateSource("app/page.tsx", PAGE);
    expect(() => parses(out)).not.toThrow();
    expect(out.split("\n")).toHaveLength(PAGE.split("\n").length);
    expect(out).toContain(`<h1 ${SOURCE_ATTR}="${target(PAGE, "<h1")}" className=`);
    expect(out).toContain(`<Button ${SOURCE_ATTR}="${target(PAGE, "<Button")}" asChild>`);
    expect(out.match(new RegExp(SOURCE_ATTR, "g"))).toHaveLength(13);
  });

  it("skips fragments, the document shell and broken files", () => {
    const code = `export default () => <html><head><title>x</title></head><body><><b>hi</b></></body></html>;`;
    const out = annotateSource("app/layout.tsx", code);
    expect(out).not.toContain(`<html ${SOURCE_ATTR}`);
    expect(out).not.toContain(`<head ${SOURCE_ATTR}`);
    expect(out).toContain(`<b ${SOURCE_ATTR}`);
    expect(annotateSource("app/page.tsx", "export default () => <div>")).toBe(
      "export default () => <div>",
    );
  });

  it("leaves shadcn's own components and non-JSX files alone", () => {
    expect(isAnnotatable("app/page.tsx")).toBe(true);
    expect(isAnnotatable("components/header.tsx")).toBe(true);
    expect(isAnnotatable("components/ui/button.tsx")).toBe(false);
    expect(isAnnotatable("lib/site.ts")).toBe(false);
  });

  it("keeps every template's pages valid", () => {
    for (const template of TEMPLATES) {
      for (const file of renderTemplate(template, { name: "Acme", kind: "website" })) {
        if (typeof file.content !== "string" || !isAnnotatable(file.path)) continue;
        expect(() => parses(annotateSource(file.path, file.content as string))).not.toThrow();
      }
    }
  });
});

describe("applyVisualEdits", () => {
  const run = (...edits: VisualEdit[]) => applyVisualEdits(files(), edits);

  it("changes plain text where the element is", () => {
    const result = run({
      kind: "text",
      target: target(PAGE, "<h1"),
      from: "Bright Smiles Dental",
      to: "Bright Smiles Family Dental",
    });
    expect(result.failed).toEqual([]);
    expect(contentOf(result, "app/page.tsx")).toContain(
      '<h1 className="text-4xl font-bold">Bright Smiles Family Dental</h1>',
    );
  });

  it("keeps text that JSX can't hold plainly as a string", () => {
    const result = run({
      kind: "text",
      target: target(PAGE, "<h1"),
      from: "Bright Smiles Dental",
      to: "Smiles {and} <more> & co",
    });
    const out = contentOf(result, "app/page.tsx") ?? "";
    expect(out).toContain('{"Smiles {and} <more> & co"}');
    expect(() => parses(out)).not.toThrow();
  });

  it("changes a string written as an expression", () => {
    const result = run({
      kind: "text",
      target: target(PAGE, "<p>{"),
      from: "Gentle care for the whole family.",
      to: "Kind care.",
    });
    expect(contentOf(result, "app/page.tsx")).toContain('<p>{"Kind care."}</p>');
  });

  it("changes text that comes from data, in the data file", () => {
    const result = run({
      kind: "text",
      target: target(PAGE, "<li"),
      from: "Whitening",
      to: "Teeth whitening",
    });
    expect(result.failed).toEqual([]);
    expect(contentOf(result, "lib/services.ts")).toContain('{ name: "Teeth whitening"');
    expect(contentOf(result, "app/page.tsx")).toBeUndefined();
  });

  it("refuses data text that more than one place holds", () => {
    const result = run({
      kind: "text",
      target: target(PAGE, "<p>{site"),
      from: "555-0100",
      to: "1",
    });
    expect(result.applied).toBe(0);
    expect(result.failed[0]?.reason).toMatch(/more than one place/);
  });

  it("refuses text with other elements inside, and text that changed since", () => {
    const result = run(
      { kind: "text", target: target(PAGE, "<p>\n"), from: "Open today", to: "Closed" },
      { kind: "text", target: target(PAGE, "<h1"), from: "Something else", to: "x" },
      { kind: "text", target: "app/page.tsx:3", from: "x", to: "y" },
    );
    expect(result.files).toEqual([]);
    expect(result.failed.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(result.failed[0]?.reason).toMatch(/other parts of the page/);
    expect(result.failed[1]?.reason).toMatch(/changed since/);
  });

  it("changes classes, image details and links", () => {
    const result = run(
      {
        kind: "attr",
        target: target(PAGE, "<h1"),
        name: "className",
        from: "text-4xl font-bold",
        to: "text-5xl font-bold text-primary",
      },
      {
        kind: "attr",
        target: target(PAGE, "<img"),
        name: "src",
        from: "/hero.jpg",
        to: "https://images.example.com/a.jpg",
      },
      {
        kind: "attr",
        target: target(PAGE, "<img"),
        name: "alt",
        from: "Our office",
        to: 'A "big" room',
      },
      {
        kind: "attr",
        target: target(PAGE, '<a href="/c'),
        name: "href",
        from: "/contact",
        to: "/book",
      },
    );
    expect(result.failed).toEqual([]);
    const out = contentOf(result, "app/page.tsx") ?? "";
    expect(out).toContain('<h1 className="text-5xl font-bold text-primary">');
    expect(out).toContain(
      '<img src="https://images.example.com/a.jpg" alt={"A \\"big\\" room"} className="rounded" />',
    );
    expect(out).toContain('<a href="/book">Book a visit</a>');
    expect(() => parses(out)).not.toThrow();
  });

  it("adds a missing attribute and refuses unsafe links and styles set in code", () => {
    const result = run(
      { kind: "attr", target: target(PAGE, "<main"), name: "placeholder", from: null, to: "x" },
      {
        kind: "attr",
        target: target(PAGE, '<a href="/c'),
        name: "href",
        from: "/contact",
        to: "javascript:alert(1)",
      },
      {
        kind: "attr",
        target: target(PAGE, "<p className={cn"),
        name: "className",
        from: "text-sm",
        to: "text-xl",
      },
    );
    expect(contentOf(result, "app/page.tsx")).toContain('<main placeholder="x" className=');
    expect(result.failed.map((f) => f.index)).toEqual([1, 2]);
  });

  it("changes an image that comes from data", () => {
    const code = `import { services } from "@/lib/services";
export default () => services.map((s) => <img key={s.name} src={s.image} alt="" />);
`;
    const result = applyVisualEdits(
      [
        { path: "app/page.tsx", content: code },
        { path: "lib/services.ts", content: SERVICES },
      ],
      [
        {
          kind: "attr",
          target: `app/page.tsx:${code.indexOf("<img")}`,
          name: "src",
          from: "/cleaning.jpg",
          to: "/new.jpg",
        },
      ],
    );
    expect(result.failed).toEqual([]);
    expect(contentOf(result, "lib/services.ts")).toContain('image: "/new.jpg"');
  });

  it("opens a link in a new tab, and back", () => {
    const on = run({ kind: "newTab", target: target(PAGE, '<a href="/c'), on: true });
    expect(contentOf(on, "app/page.tsx")).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="/contact">',
    );
    const off = run({ kind: "newTab", target: target(PAGE, '<a href="https'), on: false });
    expect(contentOf(off, "app/page.tsx")).toContain('<a href="https://example.com">');
  });

  it("refuses two changes to the same spot in one save", () => {
    const at = target(PAGE, "<h1");
    const result = run(
      { kind: "text", target: at, from: "Bright Smiles Dental", to: "A" },
      { kind: "text", target: at, from: "Bright Smiles Dental", to: "B" },
    );
    expect(result.applied).toBe(1);
    expect(result.failed[0]?.index).toBe(1);
  });

  it("finds the element from the preview's own location after annotating", () => {
    const annotated = annotateSource("app/page.tsx", PAGE);
    const at = new RegExp(`<h1 ${SOURCE_ATTR}="([^"]+)"`).exec(annotated)?.[1] ?? "";
    const result = run({ kind: "text", target: at, from: "Bright Smiles Dental", to: "Hi" });
    expect(contentOf(result, "app/page.tsx")).toContain(">Hi</h1>");
  });

  it("validates what the browser sends", () => {
    expect(VisualEdits.safeParse([]).success).toBe(false);
    expect(
      VisualEdits.safeParse([{ kind: "text", target: "../x:1", from: "a", to: "b" }]).success,
    ).toBe(true);
    expect(
      VisualEdits.safeParse([{ kind: "text", target: 'x"y:1', from: "a", to: "b" }]).success,
    ).toBe(false);
    expect(
      VisualEdits.safeParse([{ kind: "attr", target: "a:1", name: "onClick", from: null, to: "" }])
        .success,
    ).toBe(false);
  });

  it("refuses a location in a file the site doesn't have", () => {
    const result = run({ kind: "text", target: "../secret.tsx:0", from: "a", to: "b" });
    expect(result.failed[0]?.reason).toMatch(/changed since/);
  });
});

describe("previewFiles", () => {
  it("annotates pages, loads the script from the layout and adds it", () => {
    const template = TEMPLATES.find((t) => t.id === "local-business");
    if (!template) throw new Error("no local-business template");
    const draft = renderTemplate(template, { name: "Acme", kind: "website" });
    const out = previewFiles(draft);
    const layout = out.find((f) => f.path === "app/layout.tsx")?.content as string;
    expect(layout).toContain('<script src="/__locus/visual-edits.js" async /></body>');
    expect(() => parses(layout)).not.toThrow();
    expect(out.find((f) => f.path === "app/page.tsx")?.content).toContain(SOURCE_ATTR);
    expect(out.find((f) => f.path === VISUAL_EDITS_SCRIPT_PATH)?.content).toBe(VISUAL_EDITS_SCRIPT);
    // The draft itself is untouched.
    expect(draft.find((f) => f.path === "app/page.tsx")?.content).not.toContain(SOURCE_ATTR);
    expect(out.filter((f) => f.path === VISUAL_EDITS_SCRIPT_PATH)).toHaveLength(1);
  });

  it("ships a script that parses", () => {
    expect(() => new Function(VISUAL_EDITS_SCRIPT)).not.toThrow();
  });
});
