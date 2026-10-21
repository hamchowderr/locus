"use client";

import { MousePointerClick } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { SitePreview } from "@/components/site-preview/site-preview";
import { Button } from "@/components/ui/button";
import { VisualEditor } from "@/components/visual-edits/visual-editor";
import { cn } from "@/lib/utils";
import { type ChatVersions, SiteChat, useSiteChat } from "./site-chat";

type ChatSetting =
  /** The site's chat, in the site builder's mode; `refusal` says why this member can't build. */
  | { mode: string; refusal: string | null }
  /** No chat on this deployment, and why. */
  | { off: string };

/**
 * A site's workspace: the live preview, Visual edits when turned on, and the site's own chat
 * beside them. Everything sent from here (typed in the chat, or asked about a selection) goes
 * to the site builder working on this site, and the preview reloads when it changes files.
 */
export function SiteWorkspace({
  siteId,
  chat: setting,
  versions,
  className,
  ...preview
}: Omit<ComponentProps<typeof SitePreview>, "className"> & {
  siteId: string;
  chat: ChatSetting;
  /** The site's saved versions, as its chat's version cards need them. */
  versions: Omit<ChatVersions, "shown">;
  className?: string;
}) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reloads, setReloads] = useState(0);
  const mode = "mode" in setting ? setting.mode : null;
  const refusal = "mode" in setting ? setting.refusal : setting.off;
  const chat = useSiteChat({
    siteId,
    mode,
    onFilesChanged: () => setReloads((n) => n + 1),
  });
  // Changing the site needs the right to build it, and the current version in the preview.
  const canChange = mode !== null && refusal === null;

  return (
    <div className={cn("flex min-h-0 flex-col lg:flex-row", className)}>
      <SitePreview
        {...preview}
        className="min-h-[60vh] min-w-0 flex-1 p-3 lg:min-h-0"
        reloadSignal={reloads}
        onFrameLoad={setFrame}
        onPageChange={(page) => {
          setUrl(page?.url ?? null);
          if (!page) setFrame(null);
        }}
        actions={
          canChange && (
            <Button
              type="button"
              size="sm"
              variant={editing ? "default" : "outline"}
              aria-pressed={editing}
              onClick={() => setEditing((on) => !on)}
            >
              <MousePointerClick data-icon="inline-start" />
              Visual edits
            </Button>
          )
        }
      />
      {canChange && editing && (
        <VisualEditor
          siteId={siteId}
          frame={frame}
          previewUrl={url}
          ask={chat.send}
          asking={chat.busy}
          editable={preview.version === null}
          className="w-full border-t p-3 lg:w-80 lg:border-t-0 lg:border-l"
        />
      )}
      <SiteChat
        siteId={siteId}
        chat={chat}
        refusal={refusal}
        versions={{ ...versions, shown: preview.version }}
        className="h-[70vh] border-t lg:h-auto lg:w-[400px] lg:shrink-0 lg:border-t-0 lg:border-l"
      />
    </div>
  );
}
