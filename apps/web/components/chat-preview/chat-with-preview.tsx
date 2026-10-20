"use client";

import { Eye, EyeOff, PencilRuler } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, useCallback, useEffect, useState } from "react";
import { ProjectChat } from "@/components/chat-project/project-chat";
import { SitePreview } from "@/components/site-preview/site-preview";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";

/** Where the browser remembers that the person hid the preview. */
const HIDDEN_KEY = "locus.chat.previewHidden";

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, "1");
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
}

/**
 * The chat with the active site's live preview beside it, the way site builders lay it out.
 * The preview refreshes whenever the chat's work finishes. Below `lg` the two are tabs.
 * Without a site, it is just the chat.
 */
export function ChatWithPreview({
  modes,
  site,
  start,
}: {
  modes: ComponentProps<typeof ProjectChat>["modes"];
  /** The site the site builder works on, if the session chose one. */
  site: { id: string; name: string } | null;
  /** Starts that site's preview (the `previewSite` action, bound to the site). */
  start: ComponentProps<typeof SitePreview>["start"] | null;
}) {
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<"chat" | "preview">("chat");
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => setHidden(readHidden()), []);
  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
    if (next) setTab("chat");
  };
  const onWorkDone = useCallback(() => setRefreshes((n) => n + 1), []);
  const showPreview = site !== null && start !== null && !hidden;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {site && start && (
        <div className="flex items-center gap-2 border-neutral-200 border-b px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            Building <strong>{site.name}</strong>
          </span>
          {showPreview && (
            <ButtonGroup aria-label="Show" className="lg:hidden">
              <Button
                type="button"
                size="sm"
                variant={tab === "chat" ? "default" : "outline"}
                aria-pressed={tab === "chat"}
                onClick={() => setTab("chat")}
              >
                Chat
              </Button>
              <Button
                type="button"
                size="sm"
                variant={tab === "preview" ? "default" : "outline"}
                aria-pressed={tab === "preview"}
                onClick={() => setTab("preview")}
              >
                Preview
              </Button>
            </ButtonGroup>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => toggle(!hidden)}>
            {hidden ? <Eye data-icon="inline-start" /> : <EyeOff data-icon="inline-start" />}
            {hidden ? "Show preview" : "Hide preview"}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col px-4 py-4",
            showPreview
              ? cn(
                  "w-full lg:w-[26rem] lg:shrink-0 lg:border-neutral-200 lg:border-r xl:w-[30rem]",
                  tab === "preview" && "hidden lg:flex",
                )
              : "mx-auto w-full max-w-4xl",
          )}
        >
          <ProjectChat className="min-h-0 flex-1" modes={modes} onWorkDone={onWorkDone} />
        </div>
        {showPreview && site && start && (
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col gap-2 p-4",
              tab === "preview" ? "flex" : "hidden lg:flex",
            )}
          >
            <SitePreview
              start={start}
              version={null}
              refreshSignal={refreshes}
              className="min-h-0 flex-1"
              actions={
                <Link
                  href={`/sites/${encodeURIComponent(site.id)}/preview`}
                  className="inline-flex items-center gap-1 text-sm underline"
                >
                  <PencilRuler className="size-3.5" /> Visual edits
                </Link>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
