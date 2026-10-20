import { describe, expect, it } from "vitest";
import { sitePages } from "./pages.ts";
import { renderTemplate, templateById } from "./templates/index.ts";

describe("sitePages", () => {
  it("lists the addresses of a site's pages, home first", () => {
    expect(
      sitePages([
        "app/services/page.tsx",
        "app/layout.tsx",
        "app/page.tsx",
        "app/about/page.jsx",
        "components/page.tsx",
        "app/blog/[slug]/page.tsx",
        "app/(marketing)/pricing/page.tsx",
        "app/@modal/login/page.tsx",
        "app/_parts/page.tsx",
        "src/app/faq/page.mdx",
        "app/services/route.ts",
      ]),
    ).toEqual([
      { route: "/", path: "app/page.tsx" },
      { route: "/about", path: "app/about/page.jsx" },
      { route: "/faq", path: "src/app/faq/page.mdx" },
      { route: "/pricing", path: "app/(marketing)/pricing/page.tsx" },
      { route: "/services", path: "app/services/page.tsx" },
    ]);
  });

  it("finds the pages of a multi-page template", () => {
    const template = templateById("local-business");
    if (!template) throw new Error("template missing");
    const files = renderTemplate(template, { name: "Bright Smiles", kind: "website" });
    expect(sitePages(files.map((f) => f.path)).map((p) => p.route)).toEqual([
      "/",
      "/about",
      "/contact",
      "/services",
    ]);
  });
});
