import { type DesignBrief, FONTS } from "../brief.ts";
import type { SiteFile } from "../workspace.ts";
import { leadRouteFile, locusSettingsFile } from "./forms.ts";
import { shadcnComponentFiles } from "./shadcn.ts";

// The project every generated site starts as: Next.js App Router with TypeScript, Tailwind and
// shadcn/ui, so a site can render on the server, run server actions and API routes, and keep
// secrets in its host's environment. Next, React and Tailwind match apps/web, which is known to
// build together; the shadcn packages are the ones its manual installation names.
export const SITE_STACK = {
  next: "16.4.0",
  react: "19.3.0",
  "react-dom": "19.3.0",
  typescript: "7.0.2",
  "@types/node": "22.20.5",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  tailwindcss: "4.3.3",
  "@tailwindcss/postcss": "4.3.3",
  "class-variance-authority": "0.7.1",
  cn: "0.4.0",
  "lucide-react": "1.57.0",
  "radix-ui": "1.8.1",
  shadcn: "4.21.5",
  "tw-animate-css": "1.4.0",
} as const;

export const DEFAULT_PALETTE = {
  primary: "#1d4ed8",
  accent: "#f59e0b",
  background: "#ffffff",
  foreground: "#0f172a",
};

/** An npm package name from the site's name. */
export function packageName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "site";
}

/** A string as a TypeScript string literal. */
export const lit = (value: string) => JSON.stringify(value);

const luminance = (hex: string) => {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** White or near-black, whichever reads better on a colour (WCAG contrast). */
export function readableOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onWhite >= onBlack ? "#ffffff" : "#0a0a0a";
}

/**
 * shadcn/ui's theme (its CSS variables and the `@theme inline` mapping its manual installation
 * gives), with the brand's palette in place of the neutral defaults. The surface tones are
 * mixed from the background and foreground, so a dark palette works as well as a light one.
 */
function globalsCss(palette: typeof DEFAULT_PALETTE): string {
  const mix = (pct: number, color = "var(--foreground)") =>
    `color-mix(in oklab, ${color} ${pct}%, var(--background))`;
  return `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-highlight: var(--highlight);
  --color-highlight-foreground: var(--highlight-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --font-sans: var(--font-body-face), ui-sans-serif, system-ui, sans-serif;
  --font-heading: var(--font-heading-face), ui-sans-serif, system-ui, sans-serif;
}

/* The brand. primary is the main action colour; highlight is the brand's accent colour (shadcn's
   own "accent" is the subtle hover surface). */
:root {
  --radius: 0.625rem;
  --background: ${palette.background};
  --foreground: ${palette.foreground};
  --card: var(--background);
  --card-foreground: var(--foreground);
  --popover: var(--background);
  --popover-foreground: var(--foreground);
  --primary: ${palette.primary};
  --primary-foreground: ${readableOn(palette.primary)};
  --secondary: ${mix(6)};
  --secondary-foreground: var(--foreground);
  --muted: ${mix(5)};
  --muted-foreground: ${mix(68)};
  --accent: ${mix(7)};
  --accent-foreground: var(--foreground);
  --highlight: ${palette.accent};
  --highlight-foreground: ${readableOn(palette.accent)};
  --destructive: oklch(0.577 0.245 27.325);
  --border: ${mix(14)};
  --input: ${mix(18)};
  --ring: ${mix(60, "var(--primary)")};
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background font-sans text-foreground;
  }
  h1,
  h2,
  h3 {
    font-family: var(--font-heading);
  }
}
`;
}

export function baseFiles(brief: DesignBrief): SiteFile[] {
  const given = Object.entries(brief.palette ?? {}).filter(([, v]) => v !== undefined);
  const palette = { ...DEFAULT_PALETTE, ...Object.fromEntries(given) };
  const heading = FONTS[brief.fonts?.heading ?? "Inter"];
  const body = FONTS[brief.fonts?.body ?? "Inter"];
  const fontImports = [...new Set([heading, body])].join(", ");
  const s = SITE_STACK;

  return [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName(brief.name),
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            typecheck: "tsc --noEmit",
          },
          dependencies: {
            "class-variance-authority": s["class-variance-authority"],
            cn: s.cn,
            "lucide-react": s["lucide-react"],
            next: s.next,
            "radix-ui": s["radix-ui"],
            react: s.react,
            "react-dom": s["react-dom"],
          },
          devDependencies: {
            "@tailwindcss/postcss": s["@tailwindcss/postcss"],
            "@types/node": s["@types/node"],
            "@types/react": s["@types/react"],
            "@types/react-dom": s["@types/react-dom"],
            shadcn: s.shadcn,
            tailwindcss: s.tailwindcss,
            "tw-animate-css": s["tw-animate-css"],
            typescript: s.typescript,
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: ".gitignore",
      content: "node_modules/\n.next/\nout/\n.env*\n*.tsbuildinfo\nnext-env.d.ts\n.vercel\n",
    },
    {
      path: "next.config.ts",
      content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: false,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "react-jsx",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            ".next/types/**/*.ts",
            ".next/dev/types/**/*.ts",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "postcss.config.mjs",
      content: `export default { plugins: { "@tailwindcss/postcss": {} } };\n`,
    },
    {
      path: "components.json",
      content: `${JSON.stringify(
        {
          $schema: "https://ui.shadcn.com/schema.json",
          style: "new-york",
          rsc: true,
          tsx: true,
          tailwind: {
            config: "",
            css: "app/globals.css",
            baseColor: "neutral",
            cssVariables: true,
            prefix: "",
          },
          aliases: {
            components: "@/components",
            utils: "@/lib/utils",
            ui: "@/components/ui",
            lib: "@/lib",
            hooks: "@/hooks",
          },
          iconLibrary: "lucide",
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "lib/utils.ts",
      content: `/** Joins class names and resolves conflicting Tailwind classes (the later one wins). */
export { cn } from "cn";
`,
    },
    ...shadcnComponentFiles,
    { path: "app/globals.css", content: globalsCss(palette) },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";
import { ${fontImports} } from "next/font/google";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { site } from "@/lib/site";
import "./globals.css";

const headingFace = ${heading}({ subsets: ["latin"], variable: "--font-heading-face" });
const bodyFace = ${body}({ subsets: ["latin"], variable: "--font-body-face" });

export const metadata: Metadata = {
  title: { default: site.name, template: \`%s · \${site.name}\` },
  description: site.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={\`\${headingFace.variable} \${bodyFace.variable}\`}>
      <body className="flex min-h-screen flex-col antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" className="flex-1">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
`,
    },
    {
      path: "lib/site.ts",
      content: `/** The site's facts in one place, so pages never disagree. */
export const site = {
  name: ${lit(brief.name)},
  description: ${lit(brief.goal ?? brief.description?.slice(0, 160) ?? brief.name)},
  phone: "",
  email: "",
  address: "",
  nav: [] as { href: string; label: string }[],
};
`,
    },
    {
      path: "components/header.tsx",
      content: `import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { site } from "@/lib/site";

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="font-heading text-lg font-semibold">
          {site.name}
        </Link>
        {site.nav.length > 0 && (
          <>
            <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
              {site.nav.map((item) => (
                <Button key={item.href} asChild variant="ghost">
                  <Link href={item.href}>{item.label}</Link>
                </Button>
              ))}
            </nav>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden">
                  <MenuIcon />
                  <span className="sr-only">Open menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>{site.name}</SheetTitle>
                </SheetHeader>
                <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
                  {site.nav.map((item) => (
                    <SheetClose key={item.href} asChild>
                      <Link
                        href={item.href}
                        className="rounded-md px-3 py-2 text-base font-medium hover:bg-accent"
                      >
                        {item.label}
                      </Link>
                    </SheetClose>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>
    </header>
  );
}
`,
    },
    {
      path: "components/footer.tsx",
      content: `import { site } from "@/lib/site";

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:justify-between">
        <p>
          © {new Date().getFullYear()} {site.name}
        </p>
        {(site.phone || site.email) && (
          <p className="flex gap-4">
            {site.phone && <a href={\`tel:\${site.phone}\`}>{site.phone}</a>}
            {site.email && <a href={\`mailto:\${site.email}\`}>{site.email}</a>}
          </p>
        )}
      </div>
    </footer>
  );
}
`,
    },
    {
      path: "app/not-found.tsx",
      content: `import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-4 text-muted-foreground">The page you were looking for isn't here.</p>
      <Button asChild className="mt-8">
        <Link href="/">Back to the home page</Link>
      </Button>
    </section>
  );
}
`,
    },
    {
      path: "README.md",
      content: `# ${brief.name}

Built with Locus. A Next.js App Router site (TypeScript, Tailwind CSS, shadcn/ui).

\`\`\`
npm install
npm run dev
\`\`\`

UI components live in \`components/ui\` as source (shadcn/ui); the theme is in
\`app/globals.css\`.

Forms post to the site's own \`/api/lead\` route, which forwards them to Locus and on to the
business's CRM. \`lib/locus.ts\` says where; Locus writes it on every publish, and it holds no
key or token. Other settings the site reads at run time come from the host's environment
variables, never from files in this repository.
`,
    },
    locusSettingsFile({ leadEndpoint: null }),
    leadRouteFile(),
  ];
}
