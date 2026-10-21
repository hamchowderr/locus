"use client";

import { Eye, History, RotateCcw } from "lucide-react";
import Link from "next/link";
import { restoreVersion } from "@/app/(app)/sites/[siteId]/actions";
import { Button } from "@/components/ui/button";
import type { SavedVersion } from "@/lib/builder-steps";

/** How many changed files show before the rest fold away. */
const FILES_SHOWN = 3;

/**
 * The card a site chat turn ends in when the builder saved a version: what changed, and a
 * way to look at that version or go back to it.
 */
export function VersionCard({
  siteId,
  saved,
  latest,
  shown,
  canRestore,
}: {
  siteId: string;
  saved: SavedVersion;
  /** The newest version this page knows of. */
  latest: number;
  /** The version in the preview, or null for the latest files. */
  shown: number | null;
  /** Whether this member may restore versions here. */
  canRestore: boolean;
}) {
  const home = `/sites/${encodeURIComponent(siteId)}`;
  const isLatest = saved.version >= latest;
  const inPreview = shown === saved.version || (shown === null && isLatest);
  const files = saved.changed;
  return (
    <div className="my-2 rounded-xl border bg-card p-3 text-sm shadow-xs">
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <History className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="font-medium text-foreground">Version {saved.version}</span>
            {isLatest && <span className="rounded-full bg-muted px-1.5 py-0.5">Latest</span>}
          </p>
          <p className="mt-0.5 text-pretty">{saved.message}</p>
          {files.length > 0 && <ChangedFiles files={files} />}
          {saved.more && (
            <p className="mt-0.5 text-muted-foreground text-xs">
              {files.length > 0
                ? "Plus other changes (components, images or forms)."
                : "Changes to components, images or forms."}
            </p>
          )}
          {saved.publishError && (
            <p className="mt-1.5 text-destructive text-xs">{saved.publishError}</p>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 pl-9.5">
        {inPreview ? (
          <span className="inline-flex h-8 items-center gap-1.5 px-1 text-muted-foreground text-xs">
            <Eye className="size-3.5" />
            In the preview
          </span>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href={isLatest ? home : `${home}?version=${saved.version}`}>
              <Eye data-icon="inline-start" />
              Preview
            </Link>
          </Button>
        )}
        {canRestore && !isLatest && (
          <form action={restoreVersion}>
            <input type="hidden" name="siteId" value={siteId} />
            <input type="hidden" name="number" value={saved.version} />
            <input type="hidden" name="returnTo" value={home} />
            <Button type="submit" size="sm" variant="ghost">
              <RotateCcw data-icon="inline-start" />
              Restore
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function ChangedFiles({ files }: { files: string[] }) {
  const first = files.slice(0, FILES_SHOWN);
  const rest = files.slice(FILES_SHOWN);
  const list = (paths: string[]) =>
    paths.map((path) => (
      <li key={path} className="truncate font-mono text-[11px]" title={path}>
        {path}
      </li>
    ));
  return (
    <div className="mt-1.5 text-muted-foreground">
      <ul className="space-y-0.5">{list(first)}</ul>
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs hover:text-foreground group-open:hidden">
            and {rest.length} more {rest.length === 1 ? "file" : "files"}
          </summary>
          <ul className="space-y-0.5">{list(rest)}</ul>
        </details>
      )}
    </div>
  );
}
