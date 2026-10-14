import type { TenantDb } from "@locus/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefForAgent, DesignBrief, openQuestions, readBrief } from "./brief.ts";
import { startSite } from "./start.ts";
import {
  readableOn,
  renderTemplate,
  SHADCN_COMPONENTS,
  SITE_STACK,
  TEMPLATES,
} from "./templates/index.ts";
import { tenantDbForTest } from "./test-db.ts";
import { type SiteFile, SiteWorkspace } from "./workspace.ts";

const file = (files: SiteFile[], path: string) => files.find((f) => f.path === path)?.content;

let db: TenantDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await tenantDbForTest());
});
afterEach(() => close());

describe("startSite", () => {
  it("stores the brief, writes the template and saves version 1", async () => {
    const ws = new SiteWorkspace(db, "site-1");
    const { template, version } = await startSite(ws, {
      brief: { name: "Bright Smiles Dental", kind: "website", goal: "Book a cleaning" },
      templateId: "local-business",
      userId: "user-1",
    });
    expect(template.id).toBe("local-business");
    expect(version).toMatchObject({ number: 1, source: "template", createdByUserId: "user-1" });
    const paths = (await ws.listFiles()).map((f) => f.path);
    expect(paths).toContain("app/services/page.tsx");
    expect(paths).toContain("package.json");
    expect(await readBrief(db, "site-1")).toMatchObject({ templateId: "local-business" });
    await expect(startSite(ws, { brief: { name: "Again" } })).rejects.toThrow(/already/);
  });

  it("picks a template from the kind when none is chosen", async () => {
    const ws = new SiteWorkspace(db, "site-2");
    const { template } = await startSite(ws, { brief: { name: "Webinar", kind: "funnel" } });
    expect(template.id).toBe("lead-funnel");
  });

  it("lets only one of two simultaneous starts win", async () => {
    const ws = new SiteWorkspace(db, "site-4");
    const results = await Promise.allSettled([
      startSite(ws, { brief: { name: "A" }, templateId: "blank" }),
      startSite(ws, { brief: { name: "A" }, templateId: "blank" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await ws.listVersions()).map((v) => v.number)).toEqual([1]);
  });

  it("refuses an unknown template", async () => {
    const ws = new SiteWorkspace(db, "site-3");
    await expect(startSite(ws, { brief: { name: "X" }, templateId: "nope" })).rejects.toThrow(
      /no template/,
    );
  });
});

describe("templates", () => {
  const brief = DesignBrief.parse({
    name: `Joe's "Best" Plumbing`,
    palette: { primary: "#0EA5E9" },
    fonts: { heading: "Playfair Display", body: "Inter" },
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    "%s renders a complete Next.js project",
    (_, template) => {
      const files = renderTemplate(template, brief);
      const paths = files.map((f) => f.path);
      for (const required of ["package.json", "app/layout.tsx", "app/page.tsx", "tsconfig.json"]) {
        expect(paths).toContain(required);
      }
      expect(new Set(paths).size).toBe(paths.length);
      const pkg = JSON.parse(String(files.find((f) => f.path === "package.json")?.content));
      expect(pkg.name).toBe("joe-s-best-plumbing");
      for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      }
      const css = String(files.find((f) => f.path === "app/globals.css")?.content);
      expect(css).toContain("--primary: #0ea5e9");
      // Dark text reads better on a light sky blue; the brand accent stays separate.
      expect(css).toContain("--primary-foreground: #0a0a0a");
      expect(css).toContain("--highlight: #f59e0b");
      expect(css).toContain('@import "shadcn/tailwind.css"');
      // shadcn/ui is set up as its manual installation describes, components as source.
      const components = JSON.parse(String(file(files, "components.json")));
      expect(components).toMatchObject({
        aliases: { ui: "@/components/ui", utils: "@/lib/utils" },
      });
      expect(file(files, "lib/utils.ts")).toContain('export { cn } from "cn"');
      for (const name of SHADCN_COMPONENTS) {
        const source = String(file(files, `components/ui/${name}.tsx`));
        expect(source).toContain('from "@/lib/utils"');
      }
      for (const dep of ["class-variance-authority", "cn", "lucide-react", "radix-ui"]) {
        expect(pkg.dependencies[dep]).toBe(SITE_STACK[dep as keyof typeof SITE_STACK]);
      }
      expect(Object.keys(pkg.devDependencies)).toEqual(
        expect.arrayContaining(["shadcn", "tw-animate-css"]),
      );
      // Every @/components/ui import in the template's own code resolves to a vendored file.
      for (const f of files) {
        for (const [, name] of String(f.content).matchAll(/from "@\/components\/ui\/([\w-]+)"/g)) {
          expect(paths).toContain(`components/ui/${name}.tsx`);
        }
      }
      // Forms keep posting to the site's own route, with labelled fields.
      const form = file(files, "components/lead-form.tsx");
      if (form !== undefined) {
        expect(form).toContain('fetch("/api/lead"');
        expect(form).toContain('<FieldLabel htmlFor="lead-email">');
        expect(paths).toContain("app/api/lead/route.ts");
      }
      const layout = String(files.find((f) => f.path === "app/layout.tsx")?.content);
      expect(layout).toContain("import { Playfair_Display, Inter }");
      // The name is quoted as a string literal, never pasted into code.
      const site = String(files.find((f) => f.path === "lib/site.ts")?.content);
      expect(site).toContain(`name: "Joe's \\"Best\\" Plumbing"`);
    },
  );
});

describe("readableOn", () => {
  it("picks the text colour with more contrast", () => {
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(readableOn("#0f172a")).toBe("#ffffff");
    expect(readableOn("#f59e0b")).toBe("#0a0a0a");
    expect(readableOn("#ffffff")).toBe("#0a0a0a");
  });
});

describe("brief", () => {
  it("lists only the questions left open and renders for the agent", () => {
    const brief = DesignBrief.parse({ name: "X", goal: "Call us", layout: "single-page" });
    expect(openQuestions(brief).map((q) => q.id)).toEqual(["audience", "palette", "fonts"]);
    expect(briefForAgent(brief)).toContain("Visitor goal: Call us");
  });

  it("refuses bad colours and unknown fonts", () => {
    expect(() => DesignBrief.parse({ name: "X", palette: { primary: "blue" } })).toThrow();
    expect(() =>
      DesignBrief.parse({ name: "X", fonts: { heading: "Comic Sans", body: "Inter" } }),
    ).toThrow();
  });
});
