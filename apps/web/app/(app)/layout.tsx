import {
  ClientAccessDenied,
  isOperator,
  listAccessibleClients,
  operatorsFromEnv,
  resolveActiveClient,
} from "@locus/auth";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { chooseClient, signOut, switchAgency } from "@/app/actions";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { currentSession, locus, sessionContext } from "@/lib/locus";

/**
 * Every signed-in page: the menu on the left, the page on the right. Each page still checks
 * the sign-in and access itself; without a session or agency this renders the page alone,
 * and the page sends the visitor where they belong.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const current = await currentSession();
  if (!current?.session.activeOrganizationId) return children;

  const ctx = sessionContext(current);
  const db = locus().db;
  // Someone removed from the agency keeps their session for a while: they get an empty
  // menu with Sign out, not an error.
  const denied =
    <T,>(fallback: T) =>
    (e: unknown) => {
      if (e instanceof ClientAccessDenied) return fallback;
      throw e;
    };
  const [client, clients, operator, agencies] = await Promise.all([
    resolveActiveClient(db, ctx).catch(denied(null)),
    listAccessibleClients(db, ctx).catch(denied([])),
    isOperator(db, ctx, operatorsFromEnv()),
    // Only the agencies this user is a member of.
    locus().auth.api.listOrganizations({ headers: await headers() }),
  ]);
  const agency = agencies.find((a) => a.id === current.session.activeOrganizationId);

  return (
    <TooltipProvider>
      <SidebarProvider className="h-dvh">
        <AppSidebar
          subAccount={client ? { id: client.location.id, name: client.location.name } : null}
          subAccounts={clients.map((c) => ({ id: c.id, name: c.name }))}
          agency={agency ? { id: agency.id, name: agency.name } : null}
          agencies={agencies.map((a) => ({ id: a.id, name: a.name }))}
          operator={operator}
          email={current.user.email}
          chooseClient={chooseClient}
          switchAgency={switchAgency}
          signOut={signOut}
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            <span className="truncate text-sm text-muted-foreground">
              {client ? client.location.name : "No sub-account chosen"}
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
