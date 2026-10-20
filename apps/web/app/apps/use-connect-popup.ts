"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { connectAppLink } from "./actions";
import { CONNECTED_CHANNEL, type ConnectedMessage } from "./connected-message";

/** How long a sign-in may stay open before its button works again. */
const GIVE_UP_MS = 10 * 60_000;

/**
 * Opens an app's sign-in in a small window, like Claude's connectors, and reports back when
 * it returns (`onDone`) or the window is closed (`onClosed`). Used by the Apps page and by
 * the chat's Connect card.
 */
export function useConnectPopup({
  onDone,
  onError,
  onClosed,
}: {
  onDone: (message: ConnectedMessage) => void;
  onError: (message: string) => void;
  onClosed?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const popup = useRef<Window | null>(null);
  const timers = useRef<number[]>([]);
  const handlers = useRef({ onDone, onError, onClosed });
  handlers.current = { onDone, onError, onClosed };

  const stop = useCallback(() => {
    for (const id of timers.current) window.clearInterval(id);
    timers.current = [];
    setBusy(null);
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel(CONNECTED_CHANNEL);
    channel.onmessage = (event: MessageEvent<ConnectedMessage>) => {
      if (!event.data?.toolkit) return;
      popup.current?.close();
      stop();
      handlers.current.onDone(event.data);
    };
    return () => {
      channel.close();
      for (const id of timers.current) window.clearInterval(id);
    };
  }, [stop]);

  /**
   * Call from the click itself: the window must open before any await, or the browser
   * blocks it. Returns false when it was blocked, so the caller can fall back.
   */
  function connect(toolkit: string): boolean {
    const opened = window.open(
      "about:blank",
      `locus-app-connect-${toolkit}`,
      "popup,width=520,height=720",
    );
    if (!opened) return false;
    popup.current = opened;
    setBusy(toolkit);
    connectAppLink(toolkit)
      .then((result) => {
        if ("error" in result) {
          opened.close();
          stop();
          handlers.current.onError(result.error);
          return;
        }
        opened.location.href = result.url;
        const started = Date.now();
        // Watching `closed` frees the button when the person closes the window. A sign-in
        // page that cuts the link to its opener reads as closed straight away; then wait for
        // the sign-in's message instead, since a second Connect would cancel this sign-in.
        const watch = window.setInterval(() => {
          if (Date.now() - started > GIVE_UP_MS) return stop();
          if (!opened.closed) return;
          if (Date.now() - started < 3000) {
            window.clearInterval(watch);
            return;
          }
          stop();
          handlers.current.onClosed?.();
        }, 500);
        const giveUp = window.setInterval(() => stop(), GIVE_UP_MS);
        timers.current.push(watch, giveUp);
      })
      .catch(() => {
        opened.close();
        stop();
        handlers.current.onError(
          "Locus couldn't start the sign-in. Reload the page and try again.",
        );
      });
    return true;
  }

  return { connect, busy };
}
