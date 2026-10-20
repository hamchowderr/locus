import type { TenantDb } from "@locus/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefForAgent, DesignBrief, openQuestions, readBrief } from "./brief.ts";
import { startSite } from "./start.ts";
import {
  BUY_BUTTON_PATH,
  buyButtonFile,
  LOCUS_PROXY_CALLS,
  LOCUS_PROXY_PATH,
  LOCUS_SETTINGS_PATH,
  leadEndpoint,
  locusProxyFile,
  readableOn,
  renderTemplate,
  SHADCN_COMPONENTS,
  SITE_STACK,
  TEMPLATES,
  withLocusSettings,
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
      // Every site has the form route and Locus's settings, unset until it is published.
      expect(paths).toContain("app/api/lead/route.ts");
      expect(file(files, "lib/locus.ts")).toContain("leadEndpoint: null as string | null");
      const route = String(file(files, "app/api/lead/route.ts"));
      expect(route).toContain("fetch(locus.leadEndpoint");
      expect(route).toContain('"x-locus-visitor-ip"');
      // Forms keep posting to the site's own route, with labelled fields and the spam checks.
      const form = file(files, "components/lead-form.tsx");
      if (form !== undefined) {
        expect(form).toContain('fetch("/api/lead"');
        expect(form).toContain('<FieldLabel htmlFor="lead-email">');
        expect(form).toContain('name="fax"');
        expect(form).toContain("elapsedMs: Date.now() - shownAt.current");
      }
      // The route forwards without any credential of its own.
      expect(route).not.toMatch(/authorization|bearer|process\.env/i);
      // So does Locus's other route, and only the calls it lists.
      const proxy = String(file(files, LOCUS_PROXY_PATH));
      expect(file(files, "lib/locus.ts")).toContain("siteApi: null as string | null");
      expect(proxy).toContain('new Set(["GET booking/slots","POST booking","POST checkout"])');
      expect(proxy).toContain('"x-locus-visitor-ip"');
      expect(proxy).not.toMatch(/authorization|bearer|process\.env/i);
      const layout = String(files.find((f) => f.path === "app/layout.tsx")?.content);
      expect(layout).toContain("import { Playfair_Display, Inter }");
      // The name is quoted as a string literal, never pasted into code.
      const site = String(files.find((f) => f.path === "lib/site.ts")?.content);
      expect(site).toContain(`name: "Joe's \\"Best\\" Plumbing"`);
    },
  );
});

describe("Locus settings at publish", () => {
  it("points the site's form route at its own Locus endpoint, replacing any edited copy", () => {
    const files = [
      {
        path: "lib/locus.ts",
        content: "export const locus = { leadEndpoint: 'https://evil.test' };",
      },
      { path: "app/page.tsx", content: "page" },
    ];
    const published = withLocusSettings(files, {
      siteId: "site-1",
      locusUrl: "https://app.locus.test",
    });
    expect(published.filter((f) => f.path === LOCUS_SETTINGS_PATH)).toHaveLength(1);
    const settings = String(published.find((f) => f.path === LOCUS_SETTINGS_PATH)?.content);
    expect(settings).toContain('"https://app.locus.test/api/sites/site-1/leads"');
    expect(settings).toContain('siteApi: "https://app.locus.test/api/sites/site-1"');
    expect(settings).not.toContain("evil");
    // Locus's own route goes out at its current version, even into a site made before it.
    expect(published.filter((f) => f.path === LOCUS_PROXY_PATH)).toHaveLength(1);
    expect(file(published, LOCUS_PROXY_PATH)).toBe(locusProxyFile().content);
    expect(published.find((f) => f.path === "app/page.tsx")?.content).toBe("page");
    expect(leadEndpoint("https://app.locus.test/", "a/b")).toBe(
      "https://app.locus.test/api/sites/a%2Fb/leads",
    );
  });
});

describe("the buy button", () => {
  it("checks out through the site's own route, with no price or credential, and leaves only for https", () => {
    const button = buyButtonFile();
    expect(button.path).toBe(BUY_BUTTON_PATH);
    const source = String(button.content);
    expect(LOCUS_PROXY_CALLS).toContain("POST checkout");
    expect(source).toContain('fetch("/api/locus/checkout"');
    expect(source).toContain('payUrl.startsWith("https://")');
    expect(source).toContain("window.location.assign(payUrl)");
    expect(source).toContain("Checkout works on the published site.");
    // An invoice that was emailed without a payment page to open says so, and goes nowhere.
    expect(source).toContain('result?.emailed === true) return setState("emailed")');
    expect(source).toContain("We've emailed you an invoice to pay.");
    expect(source.indexOf('setState("emailed")')).toBeLessThan(
      source.indexOf("window.location.assign"),
    );
    // Name, email and phone are all required (GHL's invoice needs them), with the spam checks.
    for (const field of ['name="name"', 'name="email"', 'name="phone"']) {
      expect(source).toMatch(new RegExp(`${field}[^>]*required`));
    }
    expect(source).toContain('name="fax"');
    expect(source).toContain("elapsedMs: Date.now() - shownAt.current");
    // The amount is GHL's: the button never sends one.
    expect(source).not.toMatch(/amount|currency/);
    expect(source).not.toMatch(/authorization|bearer|process\.env/i);
    // Built from the site's own vendored components.
    for (const [, name] of source.matchAll(/from "@\/components\/ui\/([\w-]+)"/g)) {
      expect(SHADCN_COMPONENTS).toContain(name);
    }
  });
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
