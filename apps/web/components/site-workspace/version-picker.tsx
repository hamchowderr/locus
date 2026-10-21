"use client";

import { Bookmark, ChevronDown, History } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { savedAgo } from "@/lib/saved-ago";

/** One saved version, as the picker shows it. */
export type PickerVersion = {
  number: number;
  message: string;
  /** When it was saved, as an ISO string. */
  createdAt: string;
  bookmarked: boolean;
};

/**
 * The preview's version picker: the latest files, or any saved version. Choosing one shows it
 * in the preview; the page then offers to restore it.
 */
export function VersionPicker({
  siteId,
  versions,
  shown,
}: {
  siteId: string;
  versions: PickerVersion[];
  /** The version in the preview, or null for the latest files. */
  shown: number | null;
}) {
  const router = useRouter();
  const base = `/sites/${encodeURIComponent(siteId)}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="gap-1.5">
          <History data-icon="inline-start" />
          {shown === null ? "Latest" : `Version ${shown}`}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuRadioGroup
          value={shown === null ? "latest" : String(shown)}
          onValueChange={(value) =>
            router.push(value === "latest" ? base : `${base}?version=${value}`)
          }
        >
          <DropdownMenuRadioItem value="latest">
            <span className="font-medium">Latest</span>
            <span className="ml-auto text-xs text-muted-foreground">what the builder has now</span>
          </DropdownMenuRadioItem>
          {versions.length > 0 && <DropdownMenuSeparator />}
          {versions.length > 0 && <DropdownMenuLabel>Saved versions</DropdownMenuLabel>}
          {versions.map((v) => (
            <DropdownMenuRadioItem key={v.number} value={String(v.number)} className="items-start">
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1 font-medium">
                  Version {v.number}
                  {v.bookmarked && <Bookmark className="size-3" aria-label="Bookmarked" />}
                </span>
                <span className="truncate text-xs text-muted-foreground">{v.message}</span>
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {savedAgo(v.createdAt)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
