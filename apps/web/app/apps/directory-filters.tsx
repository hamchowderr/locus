"use client";

import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { directoryHref } from "./directory";

const ALL = "all";

/**
 * The directory's search box and category filter. They update the page's URL as the person
 * types, and the server renders the matching apps; without JavaScript the form does the same.
 */
export function DirectoryFilters({
  q,
  category,
  categories,
}: {
  q: string;
  category: string;
  categories: { id: string; name: string; count: number }[];
}) {
  const router = useRouter();
  const [text, setText] = useState(q);
  const [pending, startTransition] = useTransition();
  const typed = useRef(false);

  const go = (next: { q: string; category: string }) =>
    startTransition(() => router.replace(directoryHref(next), { scroll: false }));

  // Typing waits for a pause, so each key doesn't fetch a page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on typing only; the category has its own handler
  useEffect(() => {
    if (!typed.current) return;
    const timer = window.setTimeout(() => go({ q: text.trim(), category }), 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  return (
    <form
      action="/apps"
      method="get"
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(event) => {
        event.preventDefault();
        go({ q: text.trim(), category });
      }}
    >
      <label className="relative flex-1">
        <span className="sr-only">Search apps</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          name="q"
          value={text}
          onChange={(event) => {
            typed.current = true;
            setText(event.target.value);
          }}
          placeholder="Search apps"
          autoComplete="off"
          aria-busy={pending}
          className="h-9 w-full rounded-lg border border-input bg-transparent pr-3 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <Select
        name="category"
        value={category || ALL}
        onValueChange={(value) => go({ q: text.trim(), category: value === ALL ? "" : value })}
      >
        <SelectTrigger className="h-9 w-full sm:w-56" aria-label="Category">
          <SelectValue placeholder="All categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name} ({c.count})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <noscript>
        <button type="submit" className="h-9 rounded-lg border px-3 text-sm">
          Search
        </button>
      </noscript>
    </form>
  );
}
