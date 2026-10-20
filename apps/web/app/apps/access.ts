import type { AppAccess } from "@locus/harness";

/** The Apps page's words for each setting, in the order the menu lists them. */
export const ACCESS_OPTIONS: { value: AppAccess; label: string; detail: string }[] = [
  {
    value: "allow",
    label: "Always allow",
    detail: "Reads and changes run without asking. Deleting still asks first.",
  },
  {
    value: "ask_changes",
    label: "Ask before changes",
    detail: "Reads run without asking. Sending, changing or deleting waits for approval.",
  },
  {
    value: "ask",
    label: "Ask every time",
    detail: "Everything the chat does with this app waits for approval.",
  },
  {
    value: "off",
    label: "Off",
    detail: "The chat can't see or use this app. It stays connected.",
  },
];

export function accessOption(access: AppAccess): (typeof ACCESS_OPTIONS)[number] {
  const found = ACCESS_OPTIONS.find((option) => option.value === access);
  if (!found) throw new Error(`No words for the setting ${access}`);
  return found;
}
