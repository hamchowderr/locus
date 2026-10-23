import { ClientAccessDenied } from "@locus/auth";
import { ArrowLeftIcon, CheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Notice } from "@/app/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appConnectionsFromEnv, type ClientApp, clientApps, clientDbFromEnv } from "@/lib/apps";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { AccessPicker } from "../access-picker";
import { disconnectApp } from "../actions";
import { AppLogo } from "../app-logo";
import { ConnectButton } from "../connect-button";

/**
 * One connector's page, like Claude's: what the app is, Connect or Disconnect, and, once
 * connected, how the chat may use it.
 */
export default async function AppPage({ params }: { params: Promise<{ toolkit: string }> }) {
  const { toolkit } = await params;
  // Next has already decoded the segment.
  const slug = toolkit.toLowerCase();
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(`/apps/${slug}`)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const connections = appConnectionsFromEnv();
  if (!connections) redirect("/apps");
  const listing = await Promise.resolve()
    .then(() => clientApps(locus().db, sessionContext(current), connections, clientDbFromEnv()))
    .catch((e) => {
      if (e instanceof ClientAccessDenied) return null;
      console.error("App page: listing failed", e);
      return { problem: true as const };
    });
  if (!listing) redirect("/clients");
  if ("problem" in listing) {
    return (
      <Frame>
        <Notice tone="error">
          Locus couldn't load this connector just now. Reload to try again.
        </Notice>
      </Frame>
    );
  }
  const app = listing.apps.find((a) => a.toolkit === slug);
  if (!app) notFound();
  const { manager } = listing;
  const yours = app.connected || app.expired;

  return (
    <Frame
      back={yours ? "/apps?tab=yours" : "/apps?tab=discover"}
      backLabel={yours ? "Your connectors" : "Connectors"}
    >
      <header className="flex flex-col gap-4 rounded-xl bg-muted/50 p-5 sm:flex-row sm:items-center">
        <AppLogo app={app} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{app.name}</h1>
          <Status app={app} />
        </div>
        {manager && <Actions app={app} />}
      </header>

      {app.description && <p className="leading-relaxed">{app.description}</p>}
      {app.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {app.categories.map((c) => (
            <Badge key={c.id} variant="secondary">
              {c.name}
            </Badge>
          ))}
        </div>
      )}

      {app.connected && (
        <section aria-labelledby="permissions" className="space-y-2">
          <h2 id="permissions" className="font-semibold">
            Tool permissions
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose when the chat may use {app.name}. After the chat reads an email or message,
            everything it does next waits for approval, whatever you choose.
          </p>
          <AccessPicker
            toolkit={app.toolkit}
            name={app.name}
            access={app.access}
            manager={manager}
          />
        </section>
      )}
      {!manager && (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can connect apps or change how the chat uses them.
        </p>
      )}
    </Frame>
  );
}

function Frame({
  back = "/apps",
  backLabel = "Connectors",
  children,
}: {
  back?: string;
  backLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <Link
        href={back}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" /> {backLabel}
      </Link>
      {children}
    </div>
  );
}

function Status({ app }: { app: ClientApp }) {
  if (app.connected) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckIcon className="size-4 text-emerald-600" /> Connected for this sub-account
      </p>
    );
  }
  if (app.expired) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <TriangleAlertIcon className="size-4 text-amber-600" /> Its sign-in expired. Reconnect to
        use it again.
      </p>
    );
  }
  return <p className="mt-1 text-sm text-muted-foreground">Not connected</p>;
}

function Actions({ app }: { app: ClientApp }) {
  if (app.connected) return <DisconnectButton app={app} />;
  if (app.expired) {
    // An expired app can be signed in again, or removed without signing in.
    return (
      <div className="flex items-center gap-2">
        <ConnectButton toolkit={app.toolkit} name={app.name} label="Reconnect" stay />
        <DisconnectButton app={app} label="Remove" />
      </div>
    );
  }
  return <ConnectButton toolkit={app.toolkit} name={app.name} stay />;
}

function DisconnectButton({ app, label = "Disconnect" }: { app: ClientApp; label?: string }) {
  return (
    <form action={disconnectApp}>
      <input type="hidden" name="toolkit" value={app.toolkit} />
      <Button type="submit" variant="outline" size="sm" aria-label={`${label} ${app.name}`}>
        {label}
      </Button>
    </form>
  );
}
