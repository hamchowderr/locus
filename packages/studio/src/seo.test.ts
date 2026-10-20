import { describe, expect, it } from "vitest";
import { DesignBrief } from "./brief.ts";
import { pageRoute, seoIssues, siteFacts, sitePages } from "./seo.ts";
import {
  LLMS_PATH,
  LOCUS_SETTINGS_PATH,
  ROBOTS_PATH,
  renderTemplate,
  SITEMAP_PATH,
  searchFiles,
  TEMPLATES,
  withLocusSettings,
} from "./templates/index.ts";

const siteTs = `export const site = {
  name: "Bright Smiles",
  description: "Family dentist in Leeds.",
  phone: "",
};
`;

const page = (title: string, extra = "") => `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: ${title},
  description: "About the practice and the team.",${extra}
};

export default function Page() {
  return <h1>{"}"}</h1>;
}
`;

describe("pageRoute", () => {
  it("maps page files to the addresses they serve", () => {
    expect(pageRoute("app/page.tsx")).toBe("/");
    expect(pageRoute("app/services/page.tsx")).toBe("/services");
    expect(pageRoute("app/(marketing)/about/page.tsx")).toBe("/about");
    expect(pageRoute("app/blog/[slug]/page.tsx")).toBeNull();
    expect(pageRoute("app/@modal/page.tsx")).toBeNull();
    expect(pageRoute("app/_drafts/page.tsx")).toBeNull();
    expect(pageRoute("app/(.)photo/page.tsx")).toBeNull();
    expect(pageRoute("app/layout.tsx")).toBeNull();
    expect(pageRoute("components/page.tsx")).toBeNull();
  });
});

describe("sitePages", () => {
  it("reads each page's title, description, canonical and flags from its metadata", () => {
    const pages = sitePages([
      { path: "lib/site.ts", content: siteTs },
      { path: "app/page.tsx", content: "export default function Home() {}" },
      {
        path: "app/about/page.tsx",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a page's source, quoted
        content: page("`About ${site.name}`", '\n  alternates: { canonical: "/about" },'),
      },
      { path: "app/faq/page.tsx", content: `${page('{ absolute: "Questions" }')}<JsonLd />` },
      { path: "app/thanks/page.tsx", content: page('"Thanks"', "\n  robots: { index: false },") },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a page's source, quoted
      { path: "app/x/page.tsx", content: page("`${other}`") },
      { path: "public/logo.png", content: new Uint8Array([1, 2]) },
    ]);
    expect(pages.map((p) => p.path)).toEqual(["/", "/about", "/faq", "/thanks", "/x"]);
    expect(pages[0]).toMatchObject({ title: null, hasTitle: false, canonical: null });
    expect(pages[1]).toMatchObject({
      title: "About Bright Smiles",
      description: "About the practice and the team.",
      canonical: "/about",
      schema: false,
    });
    expect(pages[2]).toMatchObject({ title: "Questions", schema: true });
    expect(pages[3]).toMatchObject({ noindex: true });
    // Set, but too computed to read.
    expect(pages[4]).toMatchObject({ title: null, hasTitle: true });
    expect(siteFacts([{ path: "lib/site.ts", content: siteTs }])).toEqual({
      name: "Bright Smiles",
      description: "Family dentist in Leeds.",
    });
  });
});

describe("reading metadata like a person writes it", () => {
  const one = (content: string) => sitePages([{ path: "app/m/page.tsx", content }])[0];

  it("isn't thrown by quotes or braces in comments", () => {
    expect(
      one(`export const metadata: Metadata = {
  // Members only: don't list it. {
  /* "quoted" and 'odd */
  title: "Members", // it's private
  description: "For members.",
  robots: { index: false },
  alternates: { canonical: "/m" },
};`),
    ).toMatchObject({
      title: "Members",
      description: "For members.",
      canonical: "/m",
      noindex: true,
    });
  });

  it("reads noindex as a string or beside nested robots settings", () => {
    expect(one(`export const metadata = { robots: "noindex, nofollow" };`)?.noindex).toBe(true);
    expect(
      one(`export const metadata = { robots: { googleBot: { index: true }, index: false } };`)
        ?.noindex,
    ).toBe(true);
    expect(
      one(`export const metadata = { robots: { googleBot: { index: false } } };`)?.noindex,
    ).toBe(false);
  });

  it("takes only the page's own title and description, not its share card's", () => {
    expect(
      one(`export const metadata = {
  openGraph: { title: "Share title", description: "Share text" },
};`),
    ).toMatchObject({ title: null, hasTitle: false, description: null, hasDescription: false });
  });
});

describe("seoIssues", () => {
  it("lists missing, long and duplicate titles and descriptions, and canonicals", () => {
    const long = "x".repeat(70);
    const issues = seoIssues([
      { path: "lib/site.ts", content: siteTs },
      { path: "app/page.tsx", content: "export default function Home() {}" },
      {
        path: "app/a/page.tsx",
        content: page(`"${long}"`, '\n  alternates: { canonical: "/a" },'),
      },
      { path: "app/b/page.tsx", content: page('"Same"', '\n  alternates: { canonical: "/" },') },
      {
        path: "app/c/page.tsx",
        content: page('"Same"', '\n  alternates: { canonical: "https://x.test/c/" },'),
      },
      { path: "app/d/page.tsx", content: "export default function D() {}" },
      { path: "app/e/page.tsx", content: page('"Gone"', "\n  robots: { index: false },") },
    ]);
    const by = (path: string) => issues.filter((i) => i.page === path).map((i) => i.problem);
    expect(by("/")).toEqual([expect.stringContaining('canonical: "/"')]);
    expect(by("/a")).toEqual([expect.stringContaining("70 characters")]);
    expect(by("/b")).toEqual([expect.stringContaining("another page's")]);
    expect(by("/c")).toEqual([]);
    expect(by("/d")).toEqual([
      "No title in the page's metadata.",
      "No description in the page's metadata.",
      expect.stringContaining("No canonical"),
    ]);
    expect(by("/e")).toEqual([]);
    expect(by("/b, /c")).toEqual(['These pages share the title "Same".']);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))("finds nothing to fix in %s", (_, t) => {
    const files = renderTemplate(t, DesignBrief.parse({ name: "Bright Smiles" }));
    expect(seoIssues(files)).toEqual([]);
  });
});

describe("search files at publish", () => {
  const files = () => [
    { path: "lib/site.ts", content: siteTs },
    { path: "app/page.tsx", content: "export default function Home() {}" },
    { path: "app/about/page.tsx", content: page('"About"') },
    { path: "app/thanks/page.tsx", content: page('"Thanks"', "\n  robots: { index: false },") },
  ];
  const site = { siteId: "s1", locusUrl: "https://app.locus.test" };
  const content = (all: { path: string; content: unknown }[], path: string) =>
    all.find((f) => f.path === path)?.content;

  it("writes the address, the site's facts and its indexable pages into lib/locus.ts", () => {
    const published = withLocusSettings(files(), { ...site, siteUrl: "https://www.smiles.test" });
    const settings = String(content(published, LOCUS_SETTINGS_PATH));
    expect(settings).toContain('siteUrl: "https://www.smiles.test" as string | null');
    expect(settings).toContain('"name": "Bright Smiles"');
    expect(settings).toContain('"path": "/about"');
    expect(settings).toContain('"title": "About"');
    expect(settings).not.toContain("/thanks");
    // The home page falls back to the site's own name and description.
    expect(settings).toContain('"title": "Bright Smiles"');
    for (const path of [SITEMAP_PATH, ROBOTS_PATH, LLMS_PATH]) {
      expect(content(published, path)).toBe(content(searchFiles(), path));
    }
  });

  it("refreshes its own search files but leaves the site's own alone", () => {
    const published = withLocusSettings(
      [
        ...files(),
        { path: SITEMAP_PATH, content: "// Written by Locus. old" },
        { path: ROBOTS_PATH, content: "export default function robots() {}" },
        { path: "public/llms.txt", content: "# Ours" },
      ],
      site,
    );
    expect(content(published, SITEMAP_PATH)).toBe(content(searchFiles(), SITEMAP_PATH));
    expect(content(published, ROBOTS_PATH)).toBe("export default function robots() {}");
    expect(content(published, LLMS_PATH)).toBeUndefined();
    expect(published.filter((f) => f.path === SITEMAP_PATH)).toHaveLength(1);
  });

  it("keeps a draft out of search results", () => {
    const [template] = TEMPLATES;
    const draft = renderTemplate(
      template as (typeof TEMPLATES)[number],
      DesignBrief.parse({ name: "X" }),
    );
    const settings = String(content(draft, LOCUS_SETTINGS_PATH));
    expect(settings).toContain("leadEndpoint: null");
    expect(settings).toContain("export const published = locus.leadEndpoint !== null");
    expect(String(content(draft, ROBOTS_PATH))).toContain('disallow: "/"');
    expect(String(content(draft, "app/layout.tsx"))).toContain(
      "...(published ? {} : { robots: { index: false, follow: false } })",
    );
  });
});
