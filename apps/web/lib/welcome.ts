import {
  type AuthorizedClient,
  agencyEntitlement,
  ClientAccessDenied,
  requireAgencyManager,
  trialDaysLeft,
} from "@locus/auth";
import {
  agencyOnboarding,
  githubInstallation,
  hostConnection,
  location,
  organization,
} from "@locus/db/control";
import { and, count, eq } from "drizzle-orm";
import type { ChatStarter, ContextRow } from "@/components/chat-project/welcome";
import { brainDeps, brainNoteCount } from "./brain.ts";
import { billingEnabled, type currentSession, locus, sessionContext } from "./locus.ts";

type CurrentSession = NonNullable<Awaited<ReturnType<typeof currentSession>>>;

/** What the sub-account's chat shows before its first message. */
export interface ChatWelcome {
  greeting: string;
  intro: string;
  rows: ContextRow[];
  starters: ChatStarter[];
}

/** A new agency is shown around for its first week. */
const SHOW_AROUND_MS = 7 * 24 * 60 * 60_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The chat's welcome: a greeting by first name, what the chat works with (GoHighLevel, this
 * sub-account's brain and, for owners and admins, GitHub, Vercel and the free trial), each with
 * where to change it, and three ways to start. Missing connections say what they hold back.
 */
export async function chatWelcome(
  current: CurrentSession,
  client: AuthorizedClient,
  now = new Date(),
): Promise<ChatWelcome> {
  const { db } = locus();
  const organizationId = client.location.organizationId;
  const manager = await requireAgencyManager(db, sessionContext(current)).then(
    () => true,
    (e: unknown) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const [[agency], [clients], [setup], [github], [host], notes] = await Promise.all([
    db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId)),
    db
      .select({ n: count() })
      .from(location)
      .where(and(eq(location.organizationId, organizationId), eq(location.status, "active"))),
    db
      .select({ completedAt: agencyOnboarding.completedAt })
      .from(agencyOnboarding)
      .where(eq(agencyOnboarding.organizationId, organizationId)),
    db
      .select({ login: githubInstallation.orgLogin })
      .from(githubInstallation)
      .where(eq(githubInstallation.organizationId, organizationId)),
    db
      .select({ provider: hostConnection.provider, name: hostConnection.accountName })
      .from(hostConnection)
      .where(eq(hostConnection.organizationId, organizationId)),
    brainNoteCount(brainDeps(), client).catch(() => null),
  ]);

  let trialDays: number | null = null;
  if (manager && billingEnabled()) {
    const entitlement = await agencyEntitlement(db, organizationId, { now });
    if (entitlement.status === "trialing" && entitlement.trialEndsAt) {
      trialDays = trialDaysLeft(entitlement.trialEndsAt, now);
    }
  }
  return buildWelcome({
    firstName: current.user.name.trim().split(/\s+/)[0] ?? "",
    business: client.location.name,
    agency: agency?.name ?? null,
    clients: clients?.n ?? 0,
    notes,
    manager,
    github: github?.login ?? null,
    vercel: host?.provider === "vercel" ? { name: host.name } : null,
    trialDays,
    isNew: !!setup?.completedAt && now.getTime() - setup.completedAt.getTime() < SHOW_AROUND_MS,
  });
}

/** What the welcome is made from, read by `chatWelcome`. */
export interface WelcomeFacts {
  firstName: string;
  business: string;
  agency: string | null;
  /** Active sub-accounts in Locus. */
  clients: number;
  /** Notes in this sub-account's brain; null when it couldn't be read. */
  notes: number | null;
  /** An owner or admin: sees GitHub, Vercel and the trial, and the links to change them. */
  manager: boolean;
  github: string | null;
  vercel: { name: string | null } | null;
  /** Days left on a running free trial, shown only where billing is on. */
  trialDays: number | null;
  /** Finished its setup this week: shown around. */
  isNew: boolean;
}

/** The welcome from what is known: rows in a fixed order, missing ones saying what they hold back. */
export function buildWelcome(f: WelcomeFacts): ChatWelcome {
  const { business, notes, manager } = f;
  const hi = f.firstName ? `Hi ${f.firstName} 👋` : "Hi 👋";

  const rows: ContextRow[] = [
    {
      label: "GoHighLevel",
      // Members may reach only some sub-accounts: they hear about this one.
      detail: manager
        ? `${f.agency ?? "Your agency"}: ${plural(f.clients, "sub-account")}, read live.`
        : `${business}, read live.`,
      state: "ready",
      ...(manager ? { href: "/clients" } : {}),
    },
    {
      label: "Brain",
      detail:
        notes === null
          ? `What I know about ${business} beyond GoHighLevel.`
          : notes <= 1
            ? "Almost empty. Ask me to fill it from the website."
            : `${plural(notes, "note")} about ${business}.`,
      state: notes === null ? "info" : notes <= 1 ? "missing" : "ready",
      href: "/brain",
    },
  ];
  if (manager) {
    rows.push(
      f.github
        ? {
            label: "GitHub",
            detail: `Sites are kept in ${f.github}.`,
            state: "ready",
            href: "/connect",
          }
        : {
            label: "GitHub",
            detail: "Not connected: sites can't be published yet.",
            state: "missing",
            href: "/connect",
          },
      f.vercel
        ? {
            label: "Vercel",
            detail: `Sites go live on ${f.vercel.name ? `the ${f.vercel.name} team` : "your team"}.`,
            state: "ready",
            href: "/connect",
          }
        : {
            label: "Vercel",
            detail: "Not connected: nothing can go live yet.",
            state: "missing",
            href: "/connect",
          },
    );
  }
  if (manager && f.trialDays !== null) {
    rows.push({
      label: "Free trial",
      detail: `${f.trialDays > 0 ? `${plural(f.trialDays, "day")} left` : "Ends today"}. No card needed until you choose a plan.`,
      state: "info",
      href: "/billing",
    });
  }

  return {
    greeting: f.isNew ? `${hi} let me show you around` : hi,
    intro: f.isNew
      ? `This is ${business}'s chat. Here's what I work with. Ask for anything and I'll start a thread for it.`
      : "I'm happy to help with whatever you need. Just ask and I'll start a thread for it.",
    rows,
    starters: [
      {
        title: "Fill the brain from the website",
        description: `Draft notes about ${business}`,
        prompt: `Read ${business}'s website and draft starter notes for the brain: what we offer and charge, hours, service area, FAQs and how we talk.`,
      },
      {
        title: "Catch up on the inbox",
        description: "Which conversations need a reply",
        prompt:
          "Look through the inbox and tell me which conversations need a reply first, and why.",
      },
      {
        title: "Build a landing page",
        description: "A first page for an offer",
        prompt: `Start a thread to build a landing page for ${business}'s main offer, using what's in the brain. Ask me what you need first.`,
      },
    ],
  };
}
