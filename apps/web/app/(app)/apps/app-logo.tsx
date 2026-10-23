import type { CatalogApp } from "@locus/harness";
import { cn } from "@/lib/utils";

/** The app's logo from Composio, loaded only as it scrolls into view; its initial without one. */
export function AppLogo({ app, size = "md" }: { app: CatalogApp; size?: "sm" | "md" | "lg" }) {
  const box = { sm: "size-6 rounded-md", md: "size-10 rounded-lg", lg: "size-16 rounded-xl" }[size];
  if (!app.logo.startsWith("https://")) {
    return (
      <span
        aria-hidden
        className={cn(
          box,
          "flex shrink-0 items-center justify-center bg-muted font-medium uppercase text-muted-foreground",
          size === "lg" ? "text-xl" : "text-sm",
        )}
      >
        {app.name.slice(0, 1)}
      </span>
    );
  }
  const px = { sm: 24, md: 40, lg: 64 }[size];
  return (
    // Composio's logos come from hosts Locus doesn't list for next/image; they're small already.
    // biome-ignore lint/performance/noImgElement: see above
    <img
      src={app.logo}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn(
        box,
        "shrink-0 bg-white object-contain ring-1 ring-foreground/10",
        size === "sm" ? "p-0.5" : size === "md" ? "p-1.5" : "p-2.5",
      )}
    />
  );
}
