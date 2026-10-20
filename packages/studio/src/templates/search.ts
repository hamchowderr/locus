import type { SiteFile } from "../workspace.ts";

// The files search engines and AI tools ask a site for: /sitemap.xml, /robots.txt and
// /llms.txt. Locus owns them: they read only `lib/locus.ts` (also Locus's), so adding them to a
// site that started before them can't break its build, and each publish refreshes them. A file
// that doesn't start with Locus's marker was written by someone else and is left alone, and so
// is one whose address the site already serves another way (a file in `public/`, say).

const MARKER = "// Written by Locus.";

const owned = (path: string, content: string): SiteFile => ({
  path,
  content: `${MARKER} Don't edit it: Locus replaces it each time the site is published.\n${content}`,
});

export const SITEMAP_PATH = "app/sitemap.ts";
export const ROBOTS_PATH = "app/robots.ts";
export const LLMS_PATH = "app/llms.txt/route.ts";

/** Locus's search files, as every site gets them. */
export function searchFiles(): SiteFile[] {
  return [
    owned(
      SITEMAP_PATH,
      `import type { MetadataRoute } from "next";
import { locus, siteUrl } from "@/lib/locus";

/** /sitemap.xml: every page Locus found in the site, at its public address. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  if (!base) return [];
  return locus.pages.map((page) => ({
    url: new URL(page.path, \`\${base}/\`).toString(),
    changeFrequency: "monthly",
    priority: page.path === "/" ? 1 : 0.7,
  }));
}
`,
    ),
    owned(
      ROBOTS_PATH,
      `import type { MetadataRoute } from "next";
import { published, siteUrl } from "@/lib/locus";

/** /robots.txt: open to search engines once published, closed in a draft or preview. */
export default function robots(): MetadataRoute.Robots {
  if (!published) return { rules: { userAgent: "*", disallow: "/" } };
  const base = siteUrl();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(base ? { sitemap: \`\${base}/sitemap.xml\` } : {}),
  };
}
`,
    ),
    owned(
      LLMS_PATH,
      `import { locus, siteUrl } from "@/lib/locus";

export const dynamic = "force-static";

const plain = (text: string) => text.replace(/[\\[\\]\\r\\n]+/g, " ").trim();

/** /llms.txt: what the site is and its pages, for AI assistants (llmstxt.org). */
export function GET() {
  const base = siteUrl();
  const link = (path: string) => (base ? new URL(path, \`\${base}/\`).toString() : path);
  const lines = [\`# \${plain(locus.site.name)}\`, ""];
  if (locus.site.description) lines.push(\`> \${plain(locus.site.description)}\`, "");
  if (locus.pages.length) {
    lines.push("## Pages", "");
    for (const page of locus.pages) {
      const about = page.description ? \`: \${plain(page.description)}\` : "";
      lines.push(\`- [\${plain(page.title)}](\${link(page.path)})\${about}\`);
    }
  }
  return new Response(\`\${lines.join("\\n")}\\n\`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
`,
    ),
  ];
}

/** Other ways a site might already serve each address. */
const OTHER_SOURCES: Record<string, RegExp> = {
  [SITEMAP_PATH]: /^(?:public\/sitemap[^/]*\.xml|app\/sitemap(?:\.[a-z]+|\/.*))$/,
  [ROBOTS_PATH]: /^(?:public\/robots\.txt|app\/robots(?:\.[a-z]+|\/.*))$/,
  [LLMS_PATH]: /^(?:public\/llms\.txt|app\/llms\.txt(?:\/.*)?)$/,
};

/** The files with Locus's search files added or refreshed, where they are still Locus's. */
export function withSearchFiles(files: SiteFile[]): SiteFile[] {
  const result = [...files];
  for (const file of searchFiles()) {
    const index = result.findIndex((f) => f.path === file.path);
    const existing = result[index];
    if (existing) {
      if (typeof existing.content === "string" && existing.content.startsWith(MARKER))
        result[index] = file;
      continue;
    }
    const other = OTHER_SOURCES[file.path];
    if (other && result.some((f) => other.test(f.path))) continue;
    result.push(file);
  }
  return result;
}
