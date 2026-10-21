"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** A site's pages, as tabs. Preview is the site's own address; the rest sit under it. */
export function siteTabs(siteId: string) {
  const base = `/sites/${encodeURIComponent(siteId)}`;
  return [
    { href: base, name: "Preview" },
    { href: `${base}/versions`, name: "Versions" },
    { href: `${base}/database`, name: "Database" },
    { href: `${base}/settings`, name: "Settings" },
  ];
}

export function SiteTabs({ siteId }: { siteId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Site" className="flex items-center gap-1">
      {siteTabs(siteId).map((tab) => {
        const current = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              current
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {tab.name}
          </Link>
        );
      })}
    </nav>
  );
}
