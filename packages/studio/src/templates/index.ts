import { type DesignBrief, DesignBrief as DesignBriefSchema } from "../brief.ts";
import type { SiteFile } from "../workspace.ts";
import { baseFiles, lit } from "./base.ts";

export { baseFiles, DEFAULT_PALETTE, packageName, readableOn, SITE_STACK } from "./base.ts";
export {
  LEAD_ROUTE_PATH,
  LOCUS_SETTINGS_PATH,
  leadEndpoint,
  leadRouteFile,
  locusSettingsFile,
  withLocusSettings,
} from "./forms.ts";
export { SHADCN_COMPONENTS } from "./shadcn.ts";

export interface SiteTemplate {
  id: string;
  title: string;
  /** One line for the picker. */
  summary: string;
  kind: DesignBrief["kind"];
  /** The files the template adds or replaces on top of the base project. */
  files: (brief: DesignBrief) => SiteFile[];
}

// A form that posts to the site's own /api/lead route (in the base files), which forwards it to
// Locus and on to the client's CRM. The hidden \`fax\` field and \`elapsedMs\` are Locus's spam
// checks: people never see the one and always take longer than a bot for the other.
const leadForm = (button: string): SiteFile[] => [
  {
    path: "components/lead-form.tsx",
    content: `"use client";

import { CheckIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function LeadForm({ form = "contact" }: { form?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState("");
  const shownAt = useRef(Date.now());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...data,
        form,
        page: window.location.pathname,
        elapsedMs: Date.now() - shownAt.current,
      }),
    }).catch(() => null);
    if (response?.ok) return setState("sent");
    const result = await response?.json().catch(() => null);
    setError(typeof result?.error === "string" ? result.error : "");
    setState("failed");
  }

  if (state === "sent") {
    return (
      <p role="status" className="flex items-center gap-3 rounded-lg bg-primary/10 p-6">
        <CheckIcon className="size-5 text-primary" aria-hidden />
        Thanks! We'll be in touch shortly.
      </p>
    );
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="lead-name">Name</FieldLabel>
          <Input id="lead-name" name="name" required maxLength={120} autoComplete="name" />
        </Field>
        <Field>
          <FieldLabel htmlFor="lead-email">Email</FieldLabel>
          <Input
            id="lead-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="lead-phone">Phone (optional)</FieldLabel>
          <Input id="lead-phone" name="phone" type="tel" maxLength={32} autoComplete="tel" />
        </Field>
        <Field>
          <FieldLabel htmlFor="lead-message">How can we help?</FieldLabel>
          <Textarea id="lead-message" name="message" rows={4} maxLength={5000} />
        </Field>
        {/* Spam trap: hidden from people, filled in by bots. Keep it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="lead-fax">Leave this empty</label>
          <input id="lead-fax" name="fax" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        <Field>
          <Button type="submit" size="lg" disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : ${lit(button)}}
          </Button>
          {state === "failed" && (
            <FieldError>{error || "That didn't send. Please try again."}</FieldError>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
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

/** The hero section; pages that use it import Badge, Button and site. */
const hero = (brief: DesignBrief, eyebrow: string, cta: { href: string; label: string }) => `
      <section className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <Badge variant="secondary">{${lit(eyebrow)}}</Badge>
        <h1 className="mt-6 max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
          {site.name}
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          {${lit(brief.goal ?? "Tell visitors what you do and why it matters to them.")}}
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <a href=${lit(cta.href)}>{${lit(cta.label)}}</a>
          </Button>
        </div>
      </section>`;

/** A questions-and-answers section; pages that use it import the Accordion parts. */
const faq = (items: { q: string; a: string }[]) => `
      <section className="mx-auto max-w-3xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">Questions</h2>
        <Accordion type="single" collapsible className="mt-8">
${items
  .map(
    (item, i) => `          <AccordionItem value="q${i + 1}">
            <AccordionTrigger className="text-base">{${lit(item.q)}}</AccordionTrigger>
            <AccordionContent className="text-muted-foreground">{${lit(item.a)}}</AccordionContent>
          </AccordionItem>`,
  )
  .join("\n")}
        </Accordion>
      </section>`;

const ACCORDION_IMPORT = `import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";`;

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
      <h1 className="text-4xl font-bold tracking-tight">{site.name}</h1>
      <p className="mt-4 text-lg text-muted-foreground">{site.description}</p>
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
${ACCORDION_IMPORT}
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { site } from "@/lib/site";

const benefits = [
  { title: "Fast", text: "Say how quickly customers get results." },
  { title: "Trusted", text: "Show why people can rely on you." },
  { title: "Simple", text: "Explain how easy it is to get started." },
];

export default function Home() {
  return (
    <>${hero(brief, "New", { href: "#contact", label: "Get started" })}
      <section className="bg-muted">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-20 sm:grid-cols-3">
          {benefits.map((b) => (
            <Card key={b.title}>
              <CardHeader>
                <CardTitle className="text-xl">
                  <h2>{b.title}</h2>
                </CardTitle>
                <CardDescription className="text-base">{b.text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>${faq([
        { q: "How do I get started?", a: "Explain the first step in one or two sentences." },
        { q: "How much does it cost?", a: "Say what it costs, or how pricing works." },
        { q: "What happens next?", a: "Say what the visitor can expect after they sign up." },
      ])}
      <section id="contact" className="mx-auto max-w-xl scroll-mt-20 px-6 pb-24">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              <h2>Get in touch</h2>
            </CardTitle>
            <CardDescription>Leave your details and we'll get back to you.</CardDescription>
          </CardHeader>
          <CardContent>
            <LeadForm />
          </CardContent>
        </Card>
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
        path: "lib/services.ts",
        content: `/** The services, shared by the home and services pages. */
export const services = [
  { name: "Service one", text: "What it is and who it's for." },
  { name: "Service two", text: "What it is and who it's for." },
  { name: "Service three", text: "What it is and who it's for." },
];
`,
      },
      {
        path: "app/page.tsx",
        content: `import Link from "next/link";
${ACCORDION_IMPORT}
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { services } from "@/lib/services";
import { site } from "@/lib/site";

export default function Home() {
  return (
    <>${hero(brief, "Local and trusted", { href: "/contact", label: "Contact us" })}
      <section className="bg-muted">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">What we do</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {services.map((s) => (
              <Card key={s.name}>
                <CardHeader>
                  <CardTitle className="text-lg">
                    <h3>{s.name}</h3>
                  </CardTitle>
                  <CardDescription>{s.text}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
          <Button asChild variant="link" className="mt-6 px-0">
            <Link href="/services">See all services</Link>
          </Button>
        </div>
      </section>${faq([
        { q: "Which areas do you serve?", a: "List the towns or neighbourhoods you cover." },
        { q: "How soon can you come out?", a: "Say how quickly you can usually help." },
        { q: "Do you offer free quotes?", a: "Explain how quotes and pricing work." },
      ])}
    </>
  );
}
`,
      },
      {
        path: "app/services/page.tsx",
        content: `import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { services } from "@/lib/services";

export const metadata: Metadata = {
  title: "Services",
  description: "The services we offer and who they're for.",
};

export default function Services() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h1 className="text-4xl font-bold tracking-tight">Services</h1>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {services.map((s) => (
          <Card key={s.name}>
            <CardHeader>
              <CardTitle className="text-xl">
                <h2>{s.name}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground">{s.text}</CardContent>
          </Card>
        ))}
      </div>
      <Button asChild size="lg" className="mt-12">
        <Link href="/contact">Ask about a service</Link>
      </Button>
    </section>
  );
}
`,
      },
      {
        path: "app/about/page.tsx",
        content: `import type { Metadata } from "next";
import { Separator } from "@/components/ui/separator";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description: \`The story of \${site.name} and the people behind it.\`,
};

export default function About() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-bold tracking-tight">About {site.name}</h1>
      <Separator className="my-8" />
      <p className="text-lg text-muted-foreground">
        Tell the story of the business and the people behind it.
      </p>
    </section>
  );
}
`,
      },
      {
        path: "app/contact/page.tsx",
        content: `import type { Metadata } from "next";
import { LeadForm } from "@/components/lead-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Contact",
  description: "Send us a message and we'll get back to you.",
};

export default function Contact() {
  return (
    <section className="mx-auto max-w-xl px-6 py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">
            <h1>Contact us</h1>
          </CardTitle>
          <CardDescription>Send us a message and we'll get back to you.</CardDescription>
        </CardHeader>
        <CardContent>
          <LeadForm />
        </CardContent>
      </Card>
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
        content: `import { CheckIcon } from "lucide-react";
import { LeadForm } from "@/components/lead-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { site } from "@/lib/site";

const points = ["The first thing they get", "The second thing they get", "Why it's worth it"];

export default function OptIn() {
  return (
    <section className="mx-auto grid max-w-6xl items-start gap-12 px-6 py-20 md:grid-cols-2">
      <div>
        <Badge className="bg-highlight text-highlight-foreground">Free</Badge>
        <h1 className="mt-6 text-4xl font-bold tracking-tight text-balance sm:text-5xl">{site.name}</h1>
        <p className="mt-6 text-lg text-muted-foreground">
          {${lit(brief.goal ?? "Describe the offer in one sentence.")}}
        </p>
        <ul className="mt-8 grid gap-3">
          {points.map((point) => (
            <li key={point} className="flex items-center gap-3">
              <CheckIcon className="size-5 text-primary" aria-hidden />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">
            <h2>Get it now</h2>
          </CardTitle>
          <CardDescription>Enter your details and we'll send it straight over.</CardDescription>
        </CardHeader>
        <CardContent>
          <LeadForm />
        </CardContent>
      </Card>
    </section>
  );
}
`,
      },
      {
        path: "app/thank-you/page.tsx",
        content: `import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Thank you",
  description: "You're in. Check your inbox for the next step.",
  robots: { index: false },
};

export default function ThankYou() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="text-4xl font-bold tracking-tight">You're in!</h1>
      <p className="mt-4 text-lg text-muted-foreground">Check your inbox for the next step.</p>
      <Button asChild variant="outline" className="mt-8">
        <Link href="/">Back to the home page</Link>
      </Button>
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { site } from "@/lib/site";

const work = [
  { title: "Project one", tag: "Branding", text: "One line on the brief and the result." },
  { title: "Project two", tag: "Web design", text: "One line on the brief and the result." },
  { title: "Project three", tag: "Photography", text: "One line on the brief and the result." },
  { title: "Project four", tag: "Campaign", text: "One line on the brief and the result." },
];

export default function Home() {
  return (
    <>${hero(brief, "Portfolio", { href: "#work", label: "See the work" })}
      <section id="work" className="mx-auto grid max-w-6xl scroll-mt-20 gap-6 px-6 pb-20 sm:grid-cols-2">
        {work.map((item) => (
          <Card key={item.title} className="overflow-hidden pt-0">
            <div className="aspect-video bg-primary/10" aria-hidden />
            <CardHeader>
              <Badge variant="outline">{item.tag}</Badge>
              <CardTitle className="text-xl">
                <h2>{item.title}</h2>
              </CardTitle>
              <CardDescription>{item.text}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
      <section id="contact" className="mx-auto max-w-xl scroll-mt-20 px-6 py-20">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              <h2>Work with {site.name}</h2>
            </CardTitle>
            <CardDescription>Tell us about your project.</CardDescription>
          </CardHeader>
          <CardContent>
            <LeadForm />
          </CardContent>
        </Card>
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
