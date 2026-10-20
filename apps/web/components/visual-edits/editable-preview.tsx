"use client";

import type { ComponentProps } from "react";
import { SitePreview } from "@/components/site-preview/site-preview";
import { VisualEditor } from "./visual-editor";

/** The site preview with the Visual edits panel beside it. */
export function EditablePreview({
  siteId,
  chatMode,
  ...preview
}: ComponentProps<typeof SitePreview> & { siteId: string; chatMode: string }) {
  return (
    <SitePreview
      {...preview}
      aside={({ frame, url }) => (
        <VisualEditor
          siteId={siteId}
          frame={frame}
          previewUrl={url}
          chatMode={chatMode}
          editable={preview.version === null}
          className="border-l border-neutral-200 pl-4"
        />
      )}
    />
  );
}
