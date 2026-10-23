import { organization } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { ChevronRight, CreditCard, Users, Workflow } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Page } from "@/app/ui";
import { currentSession, locus } from "@/lib/locus";

/** The agency's settings, each on its own page. */
const SECTIONS = [
  {
    href: "/team",
    name: "Team",
    about: "Who works in Locus, and which sub-accounts each may open.",
    icon: Users,
  },
  {
    href: "/connect",
    name: "Integrations",
    about: "The agency's HighLevel, GitHub and Vercel connections.",
    icon: Workflow,
  },
  { href: "/billing", name: "Billing", about: "The agency's plan and payment.", icon: CreditCard },
] as const;

/**
 * Settings, from the account menu: who is signed in, the agency they are working in, and the
 * agency's settings pages.
 */
export default async function Settings() {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsettings");
  const orgId = current.session.activeOrganizationId;
  if (!orgId) redirect("/onboarding");
  // The agency is the session's own, never one the request names.
  const [agency] = await locus()
    .db.select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId));

  return (
    <Page title="Settings">
      <section className="space-y-1 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Your account</h2>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="truncate">{current.user.name || "Not set"}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="truncate">{current.user.email}</dd>
          <dt className="text-muted-foreground">Agency</dt>
          <dd className="truncate">{agency?.name ?? "Unknown"}</dd>
        </dl>
      </section>
      <nav aria-label="Agency settings" className="divide-y rounded-lg border">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="flex items-center gap-3 p-4 transition-colors hover:bg-muted"
          >
            <s.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{s.name}</span>
              <span className="block text-sm text-muted-foreground">{s.about}</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </nav>
    </Page>
  );
}
