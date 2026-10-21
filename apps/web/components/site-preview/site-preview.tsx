"use client";

import type { SitePage } from "@locus/studio";
import { ExternalLink, Monitor, RotateCw, Smartphone, Tablet } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";

type Started = { url: string; pages: SitePage[]; version: number | null };

/** The widths the preview can be shown at. Desktop fills the space it has. */
export const DEVICES = [
  { id: "desktop", label: "Desktop", icon: Monitor, width: null, height: null },
  { id: "tablet", label: "Tablet", icon: Tablet, width: 768, height: 1024 },
  { id: "phone", label: "Phone", icon: Smartphone, width: 390, height: 844 },
] as const;
export type DeviceId = (typeof DEVICES)[number]["id"];

/** A page's address on the preview, which must stay on the preview's own origin. */
export function pageUrl(previewUrl: string, route: string): string {
  const base = new URL(previewUrl);
  const page = new URL(`/${route.replace(/^\/+/, "")}`, base);
  return page.origin === base.origin ? page.toString() : base.toString();
}

/**
 * A site's live preview in a frame, at desktop, tablet or phone width, with a switcher for its
 * pages. `start` starts the preview on the server and returns its address and pages.
 */
export function SitePreview({
  start,
  version,
  className,
  leading,
  notice,
  actions,
  onFrameLoad,
  onPageChange,
  reloadSignal = 0,
}: {
  start: () => Promise<Started | { problem: string }>;
  version: number | null;
  className?: string;
  /** Controls at the start of the toolbar (e.g. the version picker). */
  leading?: ReactNode;
  /** A line under the toolbar (e.g. which version is shown, and restoring it). */
  notice?: ReactNode;
  /** More controls at the end of the toolbar (e.g. an editing toggle). */
  actions?: ReactNode;
  /** Called with the frame each time a page finishes loading in it. */
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
  /**
   * Called with what the frame shows: the preview's origin (to check `postMessage` senders
   * against), the page's full address and its route. Null until a preview has started.
   */
  onPageChange?: (page: { origin: string; url: string; route: string } | null) => void;
  /** Bump to load the page in the frame again (after the site builder changed files). */
  reloadSignal?: number;
}) {
  const [preview, setPreview] = useState<Started | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceId>("desktop");
  const [route, setRoute] = useState("/");
  const [reloads, setReloads] = useState(0);
  const [starting, startTransition] = useTransition();

  // The server action's identity changes whenever the page renders again (a refreshed session
  // cookie does that), so the auto-start keys on what is shown, never on `start` itself.
  const startRef = useRef(start);
  startRef.current = start;

  const run = useCallback(() => {
    setProblem(null);
    startTransition(async () => {
      const result = await startRef.current();
      if ("problem" in result) {
        setProblem(result.problem);
        return;
      }
      setPreview(result);
      setRoute((r) => (result.pages.some((p) => p.route === r) ? r : "/"));
      setReloads((n) => n + 1);
    });
  }, []);

  const started = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (started.current === version) return;
    started.current = version;
    run();
  }, [run, version]);

  const lastReload = useRef(reloadSignal);
  useEffect(() => {
    if (lastReload.current === reloadSignal) return;
    lastReload.current = reloadSignal;
    setReloads((n) => n + 1);
  }, [reloadSignal]);

  const src = preview ? pageUrl(preview.url, route) : null;
  const pageChanged = useRef(onPageChange);
  pageChanged.current = onPageChange;
  useEffect(() => {
    pageChanged.current?.(src ? { origin: new URL(src).origin, url: src, route } : null);
  }, [src, route]);

  const size = DEVICES.find((d) => d.id === device) ?? DEVICES[0];

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1 rounded-md border bg-background px-1.5 py-1">
        {leading}
        <select
          aria-label="Page"
          value={route}
          onChange={(e) => setRoute(e.target.value)}
          disabled={!preview || preview.pages.length === 0}
          className="h-8 min-w-0 max-w-48 rounded-md bg-muted/60 px-2 text-sm"
        >
          {(preview?.pages.length ? preview.pages : [{ route: "/", path: "" }]).map((p) => (
            <option key={p.route} value={p.route}>
              {p.route === "/" ? "Home  /" : p.route}
            </option>
          ))}
        </select>
        <ButtonGroup aria-label="Screen size">
          {DEVICES.map((d) => (
            <Button
              key={d.id}
              type="button"
              size="icon-sm"
              variant={device === d.id ? "secondary" : "ghost"}
              aria-pressed={device === d.id}
              aria-label={d.label}
              title={d.label}
              onClick={() => setDevice(d.id)}
            >
              <d.icon />
            </Button>
          ))}
        </ButtonGroup>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={run}
          disabled={starting}
          aria-label={starting ? "Starting the preview" : "Refresh the preview"}
          title={starting ? "Starting" : "Refresh"}
        >
          <RotateCw className={cn(starting && "animate-spin")} />
        </Button>
        {src && (
          <Button asChild size="icon-sm" variant="ghost" title="Open in a new tab">
            <a href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab">
              <ExternalLink />
            </a>
          </Button>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {problem && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem}
        </p>
      )}
      {notice}
      <div className="flex min-h-0 flex-1 justify-center overflow-auto rounded-md border border-neutral-200 bg-neutral-100 p-3">
        {src ? (
          <iframe
            key={`${src}#${reloads}`}
            title="Site preview"
            src={src}
            // The site's code is untrusted: it may run, but never steer the Locus page around it.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            onLoad={(e) => onFrameLoad?.(e.currentTarget)}
            className="shrink-0 rounded-md border border-neutral-300 bg-white shadow-sm"
            style={{
              width: size.width ? `${size.width}px` : "100%",
              height: size.height ? `${size.height}px` : "100%",
              maxHeight: size.height ? undefined : "100%",
            }}
          />
        ) : (
          <p className="self-center text-sm text-neutral-600">
            {starting
              ? "Starting the preview. The first start can take a minute or two while the site's packages install."
              : "No preview yet."}
          </p>
        )}
      </div>
    </div>
  );
}
