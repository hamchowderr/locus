"use client";

import {
  Building2,
  ChevronsUpDown,
  CreditCard,
  Library,
  LogOut,
  MessagesSquare,
  Plug,
  Shield,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { type AppPage, afterSwitch, isCurrent, menuSections } from "@/lib/app-pages";

const ICONS: Record<AppPage["icon"], typeof MessagesSquare> = {
  chat: MessagesSquare,
  sites: Library,
  connectors: Plug,
  "sub-accounts": Building2,
  team: Users,
  integrations: Workflow,
  billing: CreditCard,
  operator: Shield,
};

export type SubAccountOption = { id: string; name: string };
export type AgencyOption = { id: string; name: string };

/**
 * Locus's menu: the sub-account and agency switcher, the sub-account's pages, the agency's
 * pages, and who is signed in. The server actions come from the layout, so this file holds no
 * access checks of its own; switching goes through `chooseClient` and `switchAgency`, which
 * check access first. The agency list shows only for members of more than one.
 */
export function AppSidebar({
  subAccount,
  subAccounts,
  agency,
  agencies,
  operator,
  email,
  chooseClient,
  switchAgency,
  signOut,
}: {
  subAccount: SubAccountOption | null;
  subAccounts: readonly SubAccountOption[];
  agency: AgencyOption | null;
  agencies: readonly AgencyOption[];
  operator: boolean;
  email: string;
  chooseClient: (form: FormData) => Promise<void>;
  switchAgency: (form: FormData) => Promise<void>;
  signOut: () => Promise<void>;
}) {
  const pathname = usePathname();
  const sections = menuSections({ hasSubAccount: Boolean(subAccount), operator });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip="Switch sub-account">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                    <Building2 className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {subAccount?.name ?? "Choose a sub-account"}
                    </span>
                    <span className="truncate text-xs text-sidebar-foreground/70">
                      {agency?.name ?? "Locus"}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Sub-accounts</DropdownMenuLabel>
                {subAccounts.length === 0 && (
                  <DropdownMenuItem disabled>None you can work on yet</DropdownMenuItem>
                )}
                {subAccounts.map((option) => (
                  <form key={option.id} action={chooseClient}>
                    <input type="hidden" name="locationId" value={option.id} />
                    <input type="hidden" name="next" value={afterSwitch(pathname)} />
                    <DropdownMenuItem asChild>
                      <button type="submit" className="w-full">
                        <span className="truncate">{option.name}</span>
                        {option.id === subAccount?.id && (
                          <span className="ml-auto text-xs text-muted-foreground">Current</span>
                        )}
                      </button>
                    </DropdownMenuItem>
                  </form>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/clients">All sub-accounts</Link>
                </DropdownMenuItem>
                {agencies.length > 1 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Agencies</DropdownMenuLabel>
                    {agencies.map((option) => (
                      <form key={option.id} action={switchAgency}>
                        <input type="hidden" name="organizationId" value={option.id} />
                        <DropdownMenuItem asChild>
                          <button type="submit" className="w-full">
                            <span className="truncate">{option.name}</span>
                            {option.id === agency?.id && (
                              <span className="ml-auto text-xs text-muted-foreground">Current</span>
                            )}
                          </button>
                        </DropdownMenuItem>
                      </form>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.name}>
            <SidebarGroupLabel>{section.name}</SidebarGroupLabel>
            <SidebarMenu>
              {section.pages.map((page) => {
                const Icon = ICONS[page.icon];
                return (
                  <SidebarMenuItem key={page.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isCurrent(page, pathname)}
                      tooltip={page.name}
                    >
                      <Link href={page.href}>
                        <Icon />
                        <span>{page.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="truncate px-2 py-1 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
              {email}
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={signOut}>
              <SidebarMenuButton type="submit" tooltip="Sign out">
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
