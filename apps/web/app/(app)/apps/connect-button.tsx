"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { connectApp } from "./actions";
import { connectedPath } from "./connected-message";
import { useConnectPopup } from "./use-connect-popup";

/**
 * The Connectors page's Connect: the app's sign-in opens in a pop-up and this page updates when
 * it returns. Without JavaScript, or when the browser blocks the window, the form falls back to
 * signing in on this page.
 */
export function ConnectButton({
  toolkit,
  name,
  label = "Connect",
  icon = false,
  stay = false,
}: {
  toolkit: string;
  name?: string;
  /** The button's word: "Reconnect" for an app whose sign-in expired. */
  label?: string;
  /** A small + button, as on a directory card, with the word only for screen readers. */
  icon?: boolean;
  /** Stay on this page when the sign-in comes back, as the app's own page does. */
  stay?: boolean;
}) {
  const router = useRouter();
  const { connect, busy } = useConnectPopup({
    onDone: (message) => {
      if (message.toolkit !== toolkit) return;
      if (!stay || message.status === "failed") router.replace(connectedPath(message));
      router.refresh();
    },
    onError: (error) => router.replace(`/apps?error=${encodeURIComponent(error)}`),
    onClosed: () => router.refresh(),
  });
  const accessible = name ? `${label} ${name}` : undefined;

  return (
    <form
      action={connectApp}
      onSubmit={(event) => {
        if (connect(toolkit)) event.preventDefault();
      }}
    >
      <input type="hidden" name="toolkit" value={toolkit} />
      {icon ? (
        <Button
          type="submit"
          size="icon-sm"
          variant="outline"
          disabled={busy !== null}
          aria-label={accessible ?? label}
          title={label}
        >
          <PlusIcon />
        </Button>
      ) : (
        <Button type="submit" size="sm" disabled={busy !== null} aria-label={accessible}>
          {busy ? "Connecting…" : label}
        </Button>
      )}
    </form>
  );
}
