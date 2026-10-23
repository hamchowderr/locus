import { ClientAccessDenied } from "@locus/auth";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { appConnectionsFromEnv, type ClientApp, clientApps, clientDbFromEnv } from "@/lib/apps";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { cn } from "@/lib/utils";
import { accessOption } from "./access";
import { AppLogo } from "./app-logo";
import { ConnectButton } from "./connect-button";
import {
  categoriesOf,
  type DirectoryTab,
  directoryHref,
  filterApps,
  pageOf,
  readQuery,
  tabOf,
} from "./directory";
import { DirectoryFilters } from "./directory-filters";

type Search = {
  error?: string;
  connected?: string;
  disconnected?: string;
  q?: string;
  category?: string;
  page?: string;
  tab?: string;
};

type Query = ReturnType<typeof readQuery>;

function Shell({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
          {header}
        </div>
      </div>
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

/**
 * The client's connectors, laid out like Claude's: Yours (what's connected, and whether it
 * still works) and Discover (every app Locus offers). Each app has its own page.
 */
export default async function Apps({ searchParams }: { searchParams: Promise<Search> }) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fapps");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const params = await searchParams;
  const { error, connected, disconnected } = params;
  const query = readQuery(params);
  const connections = appConnectionsFromEnv();
  if (!connections) {
    return (
      <Shell>
        <Notice tone="info">Connectors aren't set up here yet.</Notice>
      </Shell>
    );
  }
  const ctx = sessionContext(current);
  const listing = await Promise.resolve()
    .then(() => clientApps(locus().db, ctx, connections, clientDbFromEnv()))
    .catch((e) => {
      if (e instanceof ClientAccessDenied) return null;
      console.error("Apps page: listing failed", e);
      return { problem: true as const };
    });
  if (!listing) redirect("/clients");
  if ("problem" in listing) {
    return (
      <Shell>
        <Notice tone="error">
          Locus couldn't load the connectors just now. Reload to try again.
        </Notice>
      </Shell>
    );
  }

  const tab = tabOf(query.tab, listing.apps);
  return (
    <Shell header={<Tabs tab={tab} query={query} />}>
      {error && <Notice tone="error">{error}</Notice>}
      {connected && <Notice tone="info">Back from the app's sign-in. Its status is below.</Notice>}
      {disconnected && <Notice tone="info">Connector disconnected.</Notice>}
      <DirectoryFilters
        tab={tab}
        q={query.q}
        category={query.category}
        categories={tab === "discover" ? categoriesOf(listing.apps) : undefined}
      />
      {tab === "yours" ? (
        <Yours apps={listing.apps} manager={listing.manager} query={query} />
      ) : (
        <Discover apps={listing.apps} manager={listing.manager} query={query} />
      )}
      {!listing.manager && (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can connect apps or change how the chat uses them.
        </p>
      )}
    </Shell>
  );
}

/** Claude's Yours | Discover switch. Links, so each tab has its own address. */
function Tabs({ tab, query }: { tab: DirectoryTab; query: Query }) {
  const item = (value: DirectoryTab, label: string) => (
    <Link
      href={directoryHref({ q: query.q, tab: value })}
      aria-current={tab === value ? "page" : undefined}
      scroll={false}
      className={cn(
        "rounded-md px-3 py-1 text-sm font-medium transition-colors",
        tab === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Connectors" className="inline-flex rounded-lg bg-muted p-0.5">
      {item("yours", "Yours")}
      {item("discover", "Discover")}
    </nav>
  );
}

/** The client's connected apps as a list: name, how the chat may use it, and its status. */
function Yours({ apps, manager, query }: { apps: ClientApp[]; manager: boolean; query: Query }) {
  // An app whose sign-in expired stays here, so it's seen and reconnected.
  // Yours has no category filter, so a category left in the address doesn't hide apps here.
  const yours = filterApps(apps, { q: query.q, category: "" }).filter(
    (app) => app.connected || app.expired,
  );
  if (yours.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {query.q ? "None of your connectors match." : "No connectors yet."}
        </p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link href={directoryHref({ q: query.q, tab: "discover" })}>Browse connectors</Link>
        </Button>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-2 font-normal">Connector</th>
          <th className="hidden py-2 font-normal sm:table-cell">Chat may</th>
          <th className="w-32 py-2 font-normal">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y border-t">
        {yours.map((app) => (
          <tr key={app.toolkit}>
            <td className="py-2.5 pr-3">
              <Link
                href={`/apps/${encodeURIComponent(app.toolkit)}`}
                className="flex items-center gap-3 font-medium hover:underline"
              >
                <AppLogo app={app} size="sm" />
                <span className="truncate">{app.name}</span>
              </Link>
            </td>
            <td className="hidden py-2.5 pr-3 text-muted-foreground sm:table-cell">
              {app.connected ? accessOption(app.access).label : "Nothing until reconnected"}
            </td>
            <td className="py-2.5">
              {app.connected ? (
                <CheckIcon aria-label="Connected" className="size-4" />
              ) : (
                <span className="flex items-center gap-2">
                  <TriangleAlertIcon
                    aria-label="Sign-in expired"
                    className="size-4 text-amber-600"
                  />
                  {manager && (
                    <ConnectButton toolkit={app.toolkit} name={app.name} label="Reconnect" />
                  )}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every app Locus offers, as Claude's two-column cards, connected ones first. */
function Discover({ apps, manager, query }: { apps: ClientApp[]; manager: boolean; query: Query }) {
  const matching = pageOf(filterApps(apps, query), query.page);
  if (matching.total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No apps match.{" "}
        <Link href={directoryHref({ tab: "discover" })} className="underline">
          Clear the search
        </Link>
      </p>
    );
  }
  return (
    <section aria-label="Apps" className="space-y-4">
      <h2 className="text-sm font-medium">
        {query.q || query.category ? "Matching apps" : "All apps"}{" "}
        <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {matching.total}
        </span>
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {matching.items.map((app) => (
          <li key={app.toolkit}>
            <AppCard app={app} manager={manager} />
          </li>
        ))}
      </ul>
      {matching.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-2">
          <PageLink query={query} page={matching.page - 1} disabled={matching.page <= 1}>
            Previous
          </PageLink>
          <span className="text-sm text-muted-foreground">
            Page {matching.page} of {matching.pages}
          </span>
          <PageLink
            query={query}
            page={matching.page + 1}
            disabled={matching.page >= matching.pages}
          >
            Next
          </PageLink>
        </nav>
      )}
    </section>
  );
}

function PageLink({
  query,
  page,
  disabled,
  children,
}: {
  query: Query;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={directoryHref({ ...query, tab: "discover", page })} scroll={false}>
        {children}
      </Link>
    </Button>
  );
}

/** One app: the whole card opens its page; the + connects it straight away. */
function AppCard({ app, manager }: { app: ClientApp; manager: boolean }) {
  return (
    <div className="relative flex h-full gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
      <AppLogo app={app} />
      <div className="min-w-0 flex-1">
        <Link
          href={`/apps/${encodeURIComponent(app.toolkit)}`}
          className="font-medium after:absolute after:inset-0 after:rounded-xl"
        >
          {app.name}
        </Link>
        {app.description && (
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>
        )}
      </div>
      <div className="relative z-10 shrink-0">
        {app.connected ? (
          <span className="flex size-7 items-center justify-center rounded-md border">
            <CheckIcon aria-label="Connected" className="size-4 text-emerald-600" />
          </span>
        ) : app.expired ? (
          <TriangleAlertIcon aria-label="Sign-in expired" className="m-1.5 size-4 text-amber-600" />
        ) : (
          manager && <ConnectButton toolkit={app.toolkit} name={app.name} icon />
        )}
      </div>
    </div>
  );
}
