import { ClientAccessDenied } from "@locus/auth";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { appConnectionsFromEnv, type ClientApp, clientApps, clientDbFromEnv } from "@/lib/apps";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { Notice } from "../ui";
import { AccessPicker } from "./access-picker";
import { disconnectApp } from "./actions";
import { ConnectButton } from "./connect-button";
import { categoriesOf, directoryHref, filterApps, pageOf, readQuery } from "./directory";
import { DirectoryFilters } from "./directory-filters";

type Search = {
  error?: string;
  connected?: string;
  disconnected?: string;
  q?: string;
  category?: string;
  page?: string;
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
      <div className="mt-6 space-y-6">{children}</div>
    </main>
  );
}

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
        <Notice tone="info">Connected apps aren't set up here yet.</Notice>
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

  return (
    <Shell>
      {error && <Notice tone="error">{error}</Notice>}
      {connected && <Notice tone="info">Back from the app's sign-in. Its status is below.</Notice>}
      {disconnected && <Notice tone="info">App disconnected.</Notice>}
      <p className="max-w-2xl text-neutral-600">
        The chat can use the apps connected for this client. For each one, choose whether it runs
        without asking, asks before changes (the default) or asks every time, or turn it off. After
        the chat reads an email or message, everything it does next waits for approval, whatever the
        setting.
        {!("problem" in listing) &&
          !listing.manager &&
          " Only owners and admins can connect apps or change these settings."}
      </p>
      {"problem" in listing ? (
        <Notice tone="error">Locus couldn't load the apps just now. Reload to try again.</Notice>
      ) : (
        <Directory apps={listing.apps} manager={listing.manager} query={query} />
      )}
    </Shell>
  );
}

function Directory({
  apps,
  manager,
  query,
}: {
  apps: ClientApp[];
  manager: boolean;
  query: ReturnType<typeof readQuery>;
}) {
  const matching = filterApps(apps, query);
  const connectedApps = matching.filter((app) => app.connected);
  const others = pageOf(
    matching.filter((app) => !app.connected),
    query.page,
  );
  const filtered = query.q !== "" || query.category !== "";

  return (
    <>
      <DirectoryFilters q={query.q} category={query.category} categories={categoriesOf(apps)} />
      {connectedApps.length > 0 && (
        <section aria-labelledby="connected-apps" className="space-y-3">
          <h2 id="connected-apps" className="text-sm font-medium text-neutral-600">
            Connected ({connectedApps.length})
          </h2>
          <AppGrid apps={connectedApps} manager={manager} />
        </section>
      )}
      <section aria-labelledby="all-apps" className="space-y-3">
        <h2 id="all-apps" className="text-sm font-medium text-neutral-600">
          {filtered ? "Matching apps" : "All apps"} ({others.total})
        </h2>
        {others.total === 0 ? (
          <p className="text-sm text-neutral-600">
            No apps match.{" "}
            <Link href="/apps" className="underline">
              Clear the search
            </Link>
          </p>
        ) : (
          <AppGrid apps={others.items} manager={manager} />
        )}
        {others.pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-2">
            <PageLink query={query} page={others.page - 1} disabled={others.page <= 1}>
              Previous
            </PageLink>
            <span className="text-sm text-neutral-600">
              Page {others.page} of {others.pages}
            </span>
            <PageLink query={query} page={others.page + 1} disabled={others.page >= others.pages}>
              Next
            </PageLink>
          </nav>
        )}
      </section>
    </>
  );
}

function PageLink({
  query,
  page,
  disabled,
  children,
}: {
  query: ReturnType<typeof readQuery>;
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
      <Link href={directoryHref({ ...query, page })} scroll={false}>
        {children}
      </Link>
    </Button>
  );
}

function AppGrid({ apps, manager }: { apps: ClientApp[]; manager: boolean }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {apps.map((app) => (
        <li key={app.toolkit}>
          <AppCard app={app} manager={manager} />
        </li>
      ))}
    </ul>
  );
}

function AppCard({ app, manager }: { app: ClientApp; manager: boolean }) {
  const category = app.categories[0]?.name;
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Logo app={app} />
          <div className="min-w-0">
            <CardTitle className="truncate">{app.name}</CardTitle>
            {app.connected ? (
              <span className="flex items-center gap-1 text-xs text-emerald-700">
                <CheckIcon className="size-3" /> Connected
              </span>
            ) : (
              category && (
                <Badge variant="secondary" className="mt-0.5">
                  {category}
                </Badge>
              )
            )}
          </div>
        </div>
        {manager && (
          <CardAction>
            {app.connected ? (
              <form action={disconnectApp}>
                <input type="hidden" name="toolkit" value={app.toolkit} />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  aria-label={`Disconnect ${app.name}`}
                >
                  Disconnect
                </Button>
              </form>
            ) : (
              <ConnectButton toolkit={app.toolkit} name={app.name} />
            )}
          </CardAction>
        )}
        {app.description && (
          <CardDescription className="line-clamp-2">{app.description}</CardDescription>
        )}
      </CardHeader>
      {app.connected && (
        <CardContent>
          <AccessPicker
            toolkit={app.toolkit}
            name={app.name}
            access={app.access}
            manager={manager}
          />
        </CardContent>
      )}
    </Card>
  );
}

/** The app's logo from Composio, loaded only as it scrolls into view; its initial without one. */
function Logo({ app }: { app: ClientApp }) {
  if (!app.logo.startsWith("https://")) {
    return (
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-sm font-medium uppercase text-neutral-600"
      >
        {app.name.slice(0, 1)}
      </span>
    );
  }
  return (
    // Composio's logos come from hosts Locus doesn't list for next/image; they're small already.
    // biome-ignore lint/performance/noImgElement: see above
    <img
      src={app.logo}
      alt=""
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="size-9 shrink-0 rounded-md bg-white object-contain p-1 ring-1 ring-foreground/10"
    />
  );
}
