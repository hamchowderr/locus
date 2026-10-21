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
  actions,
  onFrameLoad,
  onPageChange,
  reloadSignal = 0,
}: {
  start: () => Promise<Started | { problem: string }>;
  version: number | null;
  className?: string;
  /** More controls for the toolbar, after the built-in ones (e.g. an editing toggle). */
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
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <ButtonGroup aria-label="Screen size">
          {DEVICES.map((d) => (
            <Button
              key={d.id}
              type="button"
              size="sm"
              variant={device === d.id ? "default" : "outline"}
              aria-pressed={device === d.id}
              onClick={() => setDevice(d.id)}
            >
              <d.icon data-icon="inline-start" />
              {d.label}
            </Button>
          ))}
        </ButtonGroup>
        {actions}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-neutral-600">Page</span>
          <select
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            disabled={!preview || preview.pages.length === 0}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            {(preview?.pages.length ? preview.pages : [{ route: "/", path: "" }]).map((p) => (
              <option key={p.route} value={p.route}>
                {p.route === "/" ? "Home" : p.route}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" size="sm" variant="outline" onClick={run} disabled={starting}>
          <RotateCw data-icon="inline-start" className={cn(starting && "animate-spin")} />
          {starting ? "Starting" : "Refresh"}
        </Button>
        {src && (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline"
          >
            Open in a new tab <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {problem && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem}
        </p>
      )}
      {version !== null && preview && (
        <p className="text-sm text-neutral-600">
          This shows version {version}, apart from the site builder's own preview. Restore it on the
          Versions page to make it current.
        </p>
      )}
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
