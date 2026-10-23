"use client";

import type { AppAccess } from "@locus/harness";
import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { ACCESS_OPTIONS, accessOption } from "./access";
import { setAppAccess } from "./actions";

/**
 * How the chat may use one connected app, as a list of choices like Claude's tool permissions.
 * Owners and admins choose; everyone else sees the setting. The agent enforces it; this only
 * saves it.
 */
export function AccessPicker({
  toolkit,
  name,
  access,
  manager,
}: {
  toolkit: string;
  name: string;
  access: AppAccess;
  manager: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<AppAccess>(access);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!manager) {
    const current = accessOption(value);
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{current.label}.</span> {current.detail}
      </p>
    );
  }

  const choose = (next: AppAccess) => {
    // Rows stay enabled while saving, so the pressed one keeps keyboard focus.
    if (next === value || pending) return;
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await setAppAccess(toolkit, next);
      if ("error" in result) {
        setValue(previous);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label={`How the chat may use ${name}`}
        aria-busy={pending}
        className="divide-y overflow-hidden rounded-xl border"
      >
        {ACCESS_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a row with a label and a description reads better than a bare radio
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={pending}
              onClick={() => choose(option.value)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 aria-disabled:opacity-70",
                selected && "bg-muted/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-sm text-muted-foreground">{option.detail}</span>
              </span>
              <CheckIcon
                aria-hidden
                className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
              />
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
