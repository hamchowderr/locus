"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { connectApp } from "./actions";
import { connectedPath } from "./connected-message";
import { useConnectPopup } from "./use-connect-popup";

/**
 * The Apps page's Connect: the app's sign-in opens in a pop-up and this page updates when it
 * returns. Without JavaScript, or when the browser blocks the window, the form falls back to
 * signing in on this page.
 */
export function ConnectButton({
  toolkit,
  name,
  label = "Connect",
}: {
  toolkit: string;
  name?: string;
  /** The button's word: "Reconnect" for an app whose sign-in expired. */
  label?: string;
}) {
  const router = useRouter();
  const { connect, busy } = useConnectPopup({
    onDone: (message) => {
      if (message.toolkit !== toolkit) return;
      router.replace(connectedPath(message));
      router.refresh();
    },
    onError: (error) => router.replace(`/apps?error=${encodeURIComponent(error)}`),
    onClosed: () => router.refresh(),
  });

  return (
    <form
      action={connectApp}
      onSubmit={(event) => {
        if (connect(toolkit)) event.preventDefault();
      }}
    >
      <input type="hidden" name="toolkit" value={toolkit} />
      <Button
        type="submit"
        size="sm"
        disabled={busy !== null}
        aria-label={name ? `${label} ${name}` : undefined}
      >
        {busy ? "Connecting…" : label}
      </Button>
    </form>
  );
}
