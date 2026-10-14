import { type DesignBrief, FONTS } from "../brief.ts";
import type { SiteFile } from "../workspace.ts";

// The project every generated site starts as: Next.js App Router with TypeScript and Tailwind,
// so a site can render on the server, run server actions and API routes, and keep secrets in
// its host's environment. Versions match apps/web, which is known to build together.
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

export function baseFiles(brief: DesignBrief): SiteFile[] {
  const palette = { ...DEFAULT_PALETTE, ...brief.palette };
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
          dependencies: { next: s.next, react: s.react, "react-dom": s["react-dom"] },
          devDependencies: {
            "@tailwindcss/postcss": s["@tailwindcss/postcss"],
            "@types/node": s["@types/node"],
            "@types/react": s["@types/react"],
            "@types/react-dom": s["@types/react-dom"],
            tailwindcss: s.tailwindcss,
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
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
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
      path: "app/globals.css",
      content: `@import "tailwindcss";

@theme {
  --color-primary: ${palette.primary};
  --color-accent: ${palette.accent};
  --color-background: ${palette.background};
  --color-foreground: ${palette.foreground};
  --font-heading: var(--font-heading-face), ui-sans-serif, system-ui, sans-serif;
  --font-body: var(--font-body-face), ui-sans-serif, system-ui, sans-serif;
}

body {
  background: var(--color-background);
  color: var(--color-foreground);
  font-family: var(--font-body);
}

h1,
h2,
h3 {
  font-family: var(--font-heading);
}
`,
    },
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
        <Header />
        <main className="flex-1">{children}</main>
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
      content: `import Link from "next/link";
import { site } from "@/lib/site";

export function Header() {
  return (
    <header className="border-b border-black/10">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="font-heading text-lg font-semibold">
          {site.name}
        </Link>
        <nav className="flex gap-6 text-sm">
          {site.nav.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-primary">
              {item.label}
            </Link>
          ))}
        </nav>
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
    <footer className="border-t border-black/10">
      <div className="mx-auto max-w-6xl px-6 py-8 text-sm opacity-70">
        © {new Date().getFullYear()} {site.name}
      </div>
    </footer>
  );
}
`,
    },
    {
      path: "app/not-found.tsx",
      content: `import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-4 opacity-70">The page you were looking for isn't here.</p>
      <Link href="/" className="mt-8 inline-block text-primary underline">
        Back to the home page
      </Link>
    </section>
  );
}
`,
    },
    {
      path: "README.md",
      content: `# ${brief.name}

Built with Locus. A Next.js App Router site (TypeScript, Tailwind CSS).

\`\`\`
npm install
npm run dev
\`\`\`

Settings the site reads at run time come from the host's environment variables, never from
files in this repository.
`,
    },
  ];
}
