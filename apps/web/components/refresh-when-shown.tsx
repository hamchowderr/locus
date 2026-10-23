"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Re-reads the page's server content each time this comes into view after the page loads, so a
 * tab that was read when the page loaded (the chat's Library) shows what threads made since.
 * A hidden tab panel has no box, so the observer sees it appear when its tab is chosen.
 */
export function RefreshWhenShown({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // The observer reports once on its own when it starts; that first report is the page load.
    let started = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (started && entry?.isIntersecting) router.refresh();
      started = true;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [router]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
