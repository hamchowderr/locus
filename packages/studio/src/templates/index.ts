import { type DesignBrief, DesignBrief as DesignBriefSchema } from "../brief.ts";
import type { SiteFile } from "../workspace.ts";
import { baseFiles, lit } from "./base.ts";

export { baseFiles, DEFAULT_PALETTE, packageName, SITE_STACK } from "./base.ts";

export interface SiteTemplate {
  id: string;
  title: string;
  /** One line for the picker. */
  summary: string;
  kind: DesignBrief["kind"];
  /** The files the template adds or replaces on top of the base project. */
  files: (brief: DesignBrief) => SiteFile[];
}

// A form that posts to the site's own /api/lead route. Locus connects that route to the
// client's CRM; until then it accepts the submission and says so.
const leadForm = (button: string): SiteFile[] => [
  {
    path: "components/lead-form.tsx",
    content: `"use client";

import { useState } from "react";

export function LeadForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).catch(() => null);
    setState(response?.ok ? "sent" : "failed");
  }

  if (state === "sent") {
    return <p className="rounded-lg bg-primary/10 p-6">Thanks! We'll be in touch shortly.</p>;
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <input name="name" required placeholder="Your name" className="rounded-md border border-black/20 px-4 py-3" />
      <input name="email" type="email" required placeholder="Email" className="rounded-md border border-black/20 px-4 py-3" />
      <input name="phone" type="tel" placeholder="Phone (optional)" className="rounded-md border border-black/20 px-4 py-3" />
      <textarea name="message" rows={4} placeholder="How can we help?" className="rounded-md border border-black/20 px-4 py-3" />
      <button disabled={state === "sending"} className="rounded-md bg-primary px-6 py-3 font-semibold text-white disabled:opacity-60">
        {state === "sending" ? "Sending…" : ${lit(button)}}
      </button>
      {state === "failed" && <p className="text-sm text-red-700">That didn't send. Please try again.</p>}
    </form>
  );
}
`,
  },
  {
    path: "app/api/lead/route.ts",
    content: `import { NextResponse } from "next/server";

/** Receives the site's form submissions. Locus connects this to the client's CRM. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email.includes("@")) {
    return NextResponse.json({ error: "An email address is required." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
`,
  },
];

const navFile = (brief: DesignBrief, nav: { href: string; label: string }[]): SiteFile => ({
  path: "lib/site.ts",
  content: `/** The site's facts in one place, so pages never disagree. */
export const site = {
  name: ${lit(brief.name)},
  description: ${lit(brief.goal ?? brief.description?.slice(0, 160) ?? brief.name)},
  phone: "",
  email: "",
  address: "",
  nav: ${JSON.stringify(nav)} as { href: string; label: string }[],
};
`,
});

const hero = (brief: DesignBrief, cta: { href: string; label: string }) => `
      <section className="mx-auto max-w-6xl px-6 py-24">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">{site.name}</h1>
        <p className="mt-6 max-w-2xl text-lg opacity-80">
          {${lit(brief.goal ?? "Tell visitors what you do and why it matters to them.")}}
        </p>
        <a href=${lit(cta.href)} className="mt-10 inline-block rounded-md bg-primary px-6 py-3 font-semibold text-white">
          {${lit(cta.label)}}
        </a>
      </section>`;

export const TEMPLATES: SiteTemplate[] = [
  {
    id: "blank",
    title: "Blank",
    summary: "An empty site with the brand's colours and fonts, for the agent to build from.",
    kind: "website",
    files: (brief) => [
      {
        path: "app/page.tsx",
        content: `import { site } from "@/lib/site";

export default function Home() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <h1 className="text-4xl font-bold">{site.name}</h1>
      <p className="mt-4 opacity-80">{site.description}</p>
    </section>
  );
}
`,
      },
      navFile(brief, []),
    ],
  },
  {
    id: "landing-page",
    title: "Landing page",
    summary: "One page that sells one offer and collects leads.",
    kind: "landing-page",
    files: (brief) => [
      navFile(brief, [{ href: "#contact", label: "Get started" }]),
      ...leadForm("Get started"),
      {
        path: "app/page.tsx",
        content: `import { LeadForm } from "@/components/lead-form";
import { site } from "@/lib/site";

const benefits = [
  { title: "Fast", text: "Say how quickly customers get results." },
  { title: "Trusted", text: "Show why people can rely on you." },
  { title: "Simple", text: "Explain how easy it is to get started." },
];

export default function Home() {
  return (
    <>${hero(brief, { href: "#contact", label: "Get started" })}
      <section className="bg-primary/5">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-20 sm:grid-cols-3">
          {benefits.map((b) => (
            <div key={b.title}>
              <h2 className="text-xl font-semibold">{b.title}</h2>
              <p className="mt-2 opacity-80">{b.text}</p>
            </div>
          ))}
        </div>
      </section>
      <section id="contact" className="mx-auto max-w-xl px-6 py-20">
        <h2 className="mb-6 text-3xl font-semibold">Get in touch</h2>
        <LeadForm />
      </section>
    </>
  );
}
`,
      },
    ],
  },
  {
    id: "local-business",
    title: "Local business",
    summary: "Home, services, about and contact pages for a local service business.",
    kind: "website",
    files: (brief) => [
      navFile(brief, [
        { href: "/services", label: "Services" },
        { href: "/about", label: "About" },
        { href: "/contact", label: "Contact" },
      ]),
      ...leadForm("Send message"),
      {
        path: "app/page.tsx",
        content: `import Link from "next/link";
import { site } from "@/lib/site";

export default function Home() {
  return (
    <>${hero(brief, { href: "/contact", label: "Contact us" })}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <Link href="/services" className="text-primary underline">See our services</Link>
      </section>
    </>
  );
}
`,
      },
      {
        path: "app/services/page.tsx",
        content: `import type { Metadata } from "next";

export const metadata: Metadata = { title: "Services" };

const services = [
  { name: "Service one", text: "What it is and who it's for." },
  { name: "Service two", text: "What it is and who it's for." },
  { name: "Service three", text: "What it is and who it's for." },
];

export default function Services() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h1 className="text-4xl font-bold">Services</h1>
      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        {services.map((s) => (
          <div key={s.name} className="rounded-lg border border-black/10 p-6">
            <h2 className="text-xl font-semibold">{s.name}</h2>
            <p className="mt-2 opacity-80">{s.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`,
      },
      {
        path: "app/about/page.tsx",
        content: `import type { Metadata } from "next";
import { site } from "@/lib/site";

export const metadata: Metadata = { title: "About" };

export default function About() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-bold">About {site.name}</h1>
      <p className="mt-6 text-lg opacity-80">Tell the story of the business and the people behind it.</p>
    </section>
  );
}
`,
      },
      {
        path: "app/contact/page.tsx",
        content: `import type { Metadata } from "next";
import { LeadForm } from "@/components/lead-form";

export const metadata: Metadata = { title: "Contact" };

export default function Contact() {
  return (
    <section className="mx-auto max-w-xl px-6 py-20">
      <h1 className="mb-8 text-4xl font-bold">Contact us</h1>
      <LeadForm />
    </section>
  );
}
`,
      },
    ],
  },
  {
    id: "lead-funnel",
    title: "Lead funnel",
    summary: "An opt-in page and a thank-you page, for ads and campaigns.",
    kind: "funnel",
    files: (brief) => [
      navFile(brief, []),
      ...leadForm("Claim it now"),
      {
        path: "app/page.tsx",
        content: `import { LeadForm } from "@/components/lead-form";
import { site } from "@/lib/site";

export default function OptIn() {
  return (
    <section className="mx-auto grid max-w-6xl gap-12 px-6 py-20 md:grid-cols-2">
      <div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{site.name}</h1>
        <p className="mt-6 text-lg opacity-80">{${lit(brief.goal ?? "Describe the offer in one sentence.")}}</p>
      </div>
      <div className="rounded-xl border border-black/10 p-8 shadow-sm">
        <LeadForm />
      </div>
    </section>
  );
}
`,
      },
      {
        path: "app/thank-you/page.tsx",
        content: `import type { Metadata } from "next";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

export default function ThankYou() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="text-4xl font-bold">You're in!</h1>
      <p className="mt-4 text-lg opacity-80">Check your inbox for the next step.</p>
    </section>
  );
}
`,
      },
    ],
  },
  {
    id: "portfolio",
    title: "Portfolio",
    summary: "A showcase of work with a contact section.",
    kind: "website",
    files: (brief) => [
      navFile(brief, [
        { href: "#work", label: "Work" },
        { href: "#contact", label: "Contact" },
      ]),
      ...leadForm("Start a project"),
      {
        path: "app/page.tsx",
        content: `import { LeadForm } from "@/components/lead-form";
import { site } from "@/lib/site";

const work = ["Project one", "Project two", "Project three", "Project four"];

export default function Home() {
  return (
    <>${hero(brief, { href: "#work", label: "See the work" })}
      <section id="work" className="mx-auto grid max-w-6xl gap-6 px-6 pb-20 sm:grid-cols-2">
        {work.map((title) => (
          <article key={title} className="aspect-video rounded-xl bg-primary/10 p-6">
            <h2 className="text-xl font-semibold">{title}</h2>
          </article>
        ))}
      </section>
      <section id="contact" className="mx-auto max-w-xl px-6 py-20">
        <h2 className="mb-6 text-3xl font-semibold">Work with {site.name}</h2>
        <LeadForm />
      </section>
    </>
  );
}
`,
      },
    ],
  },
];

export function templateById(id: string): SiteTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** The template that fits a brief when the person didn't pick one. */
export function defaultTemplate(brief: DesignBrief): SiteTemplate {
  const byKind: Partial<Record<DesignBrief["kind"], string>> = {
    "landing-page": "landing-page",
    funnel: "lead-funnel",
  };
  // biome-ignore lint/style/noNonNullAssertion: "blank" is always in TEMPLATES
  return templateById(brief.templateId ?? byKind[brief.kind] ?? "blank") ?? templateById("blank")!;
}

/** The template's complete starting files for a brief: the base project plus its own files. */
export function renderTemplate(template: SiteTemplate, input: DesignBrief): SiteFile[] {
  const brief = DesignBriefSchema.parse({ ...input, templateId: template.id });
  const files = new Map<string, SiteFile>();
  for (const file of [...baseFiles(brief), ...template.files(brief)]) files.set(file.path, file);
  return [...files.values()];
}
