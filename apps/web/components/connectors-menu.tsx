"use client";

import { Blocks, Plus, Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type ChatConnector, chatConnectors } from "@/app/(app)/chat/connectors";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { readConnectorsOff, setConnectorOff } from "@/lib/chat-connectors";
import { cn } from "@/lib/utils";

type Listing = { apps: ChatConnector[] } | { error: string } | null;

/**
 * Connectors in the chat's + menu, as Claude has them: the sub-account's connected apps, each
 * with a switch for this chat, and links to the Connectors page. A switch only takes an app
 * away from the chat; the Connectors page decides the rest.
 */
export function ConnectorsMenu({ scope }: { scope: string }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>(null);
  const [off, setOff] = useState<string[]>([]);

  useEffect(() => setOff(readConnectorsOff(scope)), [scope]);

  // Read when the submenu first opens, so the chat page doesn't wait on the app catalog.
  useEffect(() => {
    if (!open || listing) return;
    let live = true;
    chatConnectors().then(
      (result) => live && setListing(result),
      () => live && setListing({ error: "Locus couldn't load your connectors just now." }),
    );
    return () => {
      live = false;
    };
  }, [open, listing]);

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <Blocks className="size-4" aria-hidden />
        Connectors
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <DropdownMenuItem asChild>
          <Link href="/apps?tab=discover">
            <Plus aria-hidden />
            Add connector
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/apps?tab=yours">
            <Settings2 aria-hidden />
            Manage connectors
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!listing ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
        ) : "error" in listing ? (
          <p className="px-2 py-1.5 text-sm text-destructive">{listing.error}</p>
        ) : listing.apps.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No connectors yet.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {listing.apps.map((app) =>
              app.expired ? (
                <DropdownMenuItem key={app.toolkit} asChild>
                  <Link href={`/apps/${encodeURIComponent(app.toolkit)}`}>
                    <Logo app={app} />
                    <span className="min-w-0 flex-1 truncate">{app.name}</span>
                    <TriangleAlert className="text-amber-600" aria-label="Sign-in expired" />
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  key={app.toolkit}
                  role="menuitemcheckbox"
                  aria-checked={!off.includes(app.toolkit)}
                  // The menu stays open, so several can be switched in one go.
                  onSelect={(event) => {
                    event.preventDefault();
                    setOff(setConnectorOff(scope, app.toolkit, !off.includes(app.toolkit)));
                  }}
                >
                  <Logo app={app} />
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  <Toggle on={!off.includes(app.toolkit)} />
                </DropdownMenuItem>
              ),
            )}
          </div>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Claude's small switch, drawn only: the menu item is the control. */
function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
        on ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute size-3 rounded-full bg-background shadow-sm transition-transform",
          on ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </span>
  );
}

function Logo({ app }: { app: ChatConnector }) {
  if (!app.logo.startsWith("https://")) {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium uppercase"
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
      width={20}
      height={20}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-5 shrink-0 rounded bg-white object-contain p-px"
    />
  );
}
