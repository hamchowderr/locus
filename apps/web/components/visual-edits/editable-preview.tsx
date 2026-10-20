"use client";

import { type ComponentProps, useState } from "react";
import { SitePreview } from "@/components/site-preview/site-preview";
import { cn } from "@/lib/utils";
import { VisualEditor } from "./visual-editor";

/** The site preview with the Visual edits panel beside it. */
export function EditablePreview({
  siteId,
  chatMode,
  canEdit,
  className,
  ...preview
}: ComponentProps<typeof SitePreview> & { siteId: string; chatMode: string; canEdit: boolean }) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  return (
    <div className={cn("flex min-h-0 gap-4", className)}>
      <SitePreview
        {...preview}
        className="min-h-0 min-w-0 flex-1"
        onFrameLoad={setFrame}
        onPageChange={(page) => {
          setUrl(page?.url ?? null);
          if (!page) setFrame(null);
        }}
      />
      <VisualEditor
        siteId={siteId}
        frame={frame}
        previewUrl={url}
        chatMode={chatMode}
        editable={canEdit && preview.version === null}
        className="border-l border-neutral-200 pl-4"
      />
    </div>
  );
}
