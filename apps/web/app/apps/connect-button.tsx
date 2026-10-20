"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { connectApp, connectAppLink } from "./actions";
import { CONNECTED_CHANNEL, type ConnectedMessage, connectedPath } from "./connected-message";

const POPUP = "locus-app-connect";

/**
 * Connect opens the app's sign-in in a small window, like Claude's connectors, and this page
 * updates when the sign-in reports back or the window closes. Without JavaScript, or when the
 * browser blocks the window, the form falls back to signing in on this page.
 */
export function ConnectButton({ toolkit }: { toolkit: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CONNECTED_CHANNEL);
    channel.onmessage = (event: MessageEvent<ConnectedMessage>) => {
      if (event.data?.toolkit !== toolkit) return;
      popup.current?.close();
      router.replace(connectedPath(event.data));
      router.refresh();
    };
    return () => channel.close();
  }, [router, toolkit]);

  async function open(event: React.FormEvent<HTMLFormElement>) {
    // Opened before any await, so the browser counts it as the person's click.
    const window_ = window.open("about:blank", POPUP, "popup,width=520,height=720");
    if (!window_) return; // blocked: the form posts as usual
    event.preventDefault();
    popup.current = window_;
    setBusy(true);
    const result = await connectAppLink(toolkit);
    if ("error" in result) {
      window_.close();
      setBusy(false);
      router.replace(`/apps?error=${encodeURIComponent(result.error)}`);
      return;
    }
    window_.location.href = result.url;
    const watch = window.setInterval(() => {
      if (!window_.closed) return;
      window.clearInterval(watch);
      setBusy(false);
      router.refresh();
    }, 500);
  }

  return (
    <form action={connectApp} onSubmit={open}>
      <input type="hidden" name="toolkit" value={toolkit} />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm disabled:opacity-60"
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
    </form>
  );
}
