/**
 * Locus's page map: every page in the menu, in the order shown, under the heading it belongs
 * to. The menu is built from this list, so a new page is added here and nowhere else.
 */
export type AppPage = {
  /** The page's address. Also matches every page under it (`/sites/abc/versions`). */
  href: string;
  /** Its name in the menu and as the page title. */
  name: string;
  icon: "chat" | "connectors" | "sub-accounts" | "team" | "integrations" | "operator";
  /** Shown only to operators (Otaku staff). */
  operatorOnly?: true;
  /** Shown only to the agency's owners and admins: a member can't use it. */
  managerOnly?: true;
  /** Other addresses that count as this page in the menu (a site opened from the chat). */
  also?: readonly string[];
};

export type AppSection = { name: string; pages: readonly AppPage[] };

/**
 * The pages that work on the chosen sub-account. They need one chosen. Its Library is a tab
 * beside the chat, not a page of its own here.
 */
export const SUB_ACCOUNT_PAGES: AppSection = {
  name: "Sub-account",
  pages: [
    { href: "/chat", name: "Chat", icon: "chat", also: ["/sites"] },
    { href: "/apps", name: "Connectors", icon: "connectors" },
  ],
};

/** The pages for the whole agency. Settings and Billing are in the account menu, at the bottom. */
export const AGENCY_PAGES: AppSection = {
  name: "Agency",
  pages: [
    { href: "/clients", name: "Sub-accounts", icon: "sub-accounts" },
    { href: "/team", name: "Team", icon: "team", managerOnly: true },
    { href: "/connect", name: "Integrations", icon: "integrations", managerOnly: true },
    { href: "/operator", name: "Operator", icon: "operator", operatorOnly: true },
  ],
};

/**
 * The menu's sections for this person: Sub-account only once one is chosen, and the agency's
 * own pages only for those who can use them.
 */
export function menuSections({
  hasSubAccount,
  operator,
  manager,
}: {
  hasSubAccount: boolean;
  operator: boolean;
  /** One of the agency's owners or admins. */
  manager: boolean;
}): AppSection[] {
  const agency = {
    ...AGENCY_PAGES,
    pages: AGENCY_PAGES.pages.filter(
      (page) => (operator || !page.operatorOnly) && (manager || !page.managerOnly),
    ),
  };
  return hasSubAccount ? [SUB_ACCOUNT_PAGES, agency] : [agency];
}

/** Whether `pathname` is `page` or a page under it, for highlighting the menu. */
export function isCurrent(page: Pick<AppPage, "href" | "also">, pathname: string): boolean {
  return [page.href, ...(page.also ?? [])].some(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
}

/**
 * Where to go after switching sub-account: the same menu page, but never a page under it,
 * since a site or version belongs to the previous sub-account. Chat when it isn't a menu page.
 */
export function afterSwitch(pathname: string): string {
  const page = SUB_ACCOUNT_PAGES.pages.find((p) => isCurrent(p, pathname));
  return page?.href ?? "/chat";
}
