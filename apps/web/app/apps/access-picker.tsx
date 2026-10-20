"use client";

import type { AppAccess } from "@locus/harness";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACCESS_OPTIONS, accessOption } from "./access";
import { setAppAccess } from "./actions";

/**
 * How the chat may use one connected app. Owners and admins choose; everyone else sees the
 * setting. The agent enforces it; this only saves it.
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
  const current = accessOption(value);

  if (!manager) {
    return (
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{current.label}.</span> {current.detail}
      </p>
    );
  }

  const choose = (next: string) => {
    const previous = value;
    setValue(next as AppAccess);
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
    <div className="space-y-1.5">
      <Select value={value} onValueChange={choose} disabled={pending}>
        <SelectTrigger
          className="h-8 w-full"
          aria-label={`How the chat may use ${name}`}
          aria-busy={pending}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ACCESS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{current.detail}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
