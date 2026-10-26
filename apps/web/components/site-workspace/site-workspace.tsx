"use client";

import { MousePointerClick } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ComponentProps, useEffect, useState } from "react";
import { SitePreview } from "@/components/site-preview/site-preview";
import { Button } from "@/components/ui/button";
import { storedCount } from "@/components/visual-edits/use-visual-edits";
import { VisualEditor } from "@/components/visual-edits/visual-editor";
import { lastCheckFailure } from "@/lib/builder-steps";
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
  threadId = null,
  className,
  ...preview
}: Omit<ComponentProps<typeof SitePreview>, "className"> & {
  siteId: string;
  chat: ChatSetting;
  /** A thread of the main chat's that builds this site, to show instead of the site's chat. */
  threadId?: string | null;
  /** The site's saved versions, as its chat's version cards need them. */
  versions: Omit<ChatVersions, "shown">;
  className?: string;
}) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Unsaved visual edits, which wait (in this tab) when the panel is closed.
  const [unsaved, setUnsaved] = useState(0);
  useEffect(() => setUnsaved(storedCount(siteId)), [siteId]);
  const [reloads, setReloads] = useState(0);
  const mode = "mode" in setting ? setting.mode : null;
  const refusal = "mode" in setting ? setting.refusal : setting.off;
  const router = useRouter();
  const chat = useSiteChat({
    siteId,
    mode,
    threadId,
    // Reload the preview, and the page's versions (the picker, and what's newest).
    onFilesChanged: () => {
      setReloads((n) => n + 1);
      router.refresh();
    },
  });
  // Changing the site needs the right to build it, and the current version in the preview.
  const canChange = mode !== null && refusal === null;
  // A build that failed stays in view over the draft's preview until a later check passes, so
  // the preview is never taken for a site that builds. A saved version is not what was checked.
  const brokenBuild =
    preview.version === null ? lastCheckFailure(chat.controller.transcript.messages) : null;

  return (
    <div className={cn("flex min-h-0 flex-col lg:flex-row", className)}>
      <SitePreview
        {...preview}
        className="min-h-[60vh] min-w-0 flex-1 p-3 lg:min-h-0"
        reloadSignal={reloads}
        notice={
          <>
            {preview.notice}
            {brokenBuild && (
              <p
                role="status"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm"
              >
                The last build check failed: <span className="break-words">{brokenBuild}</span>
              </p>
            )}
          </>
        }
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
              {unsaved > 0 && (
                <span
                  title={`${unsaved} not saved yet`}
                  className="rounded-full bg-amber-400 px-1.5 text-[11px] text-black leading-4"
                >
                  {unsaved}
                </span>
              )}
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
          onPendingChange={setUnsaved}
          // The new version shows in the version picker and on Versions.
          onSaved={() => router.refresh()}
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
