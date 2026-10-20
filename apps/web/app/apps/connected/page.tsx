"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { CONNECTED_CHANNEL, type ConnectedMessage, connectedPath } from "../connected-message";

/**
 * Where an app's sign-in comes back, in the Connect pop-up or in a tab Composio opened. It
 * tells the Apps page and closes; if the browser won't close it, it goes on to the Apps page.
 * It trusts nothing it is told: the Apps page re-reads the client's apps from Composio.
 */
function Connected() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const message: ConnectedMessage = {
      toolkit: params.get("toolkit") ?? "",
      status: params.get("status") ?? "success",
    };
    const channel = new BroadcastChannel(CONNECTED_CHANNEL);
    channel.postMessage(message);
    channel.close();
    window.close();
    // Still here: this window wasn't opened by a script, so show the Apps page in it.
    const fallback = window.setTimeout(() => router.replace(connectedPath(message)), 300);
    return () => window.clearTimeout(fallback);
  }, [params, router]);

  return <p className="p-6 text-neutral-600">Done. You can close this window.</p>;
}

export default function ConnectedPage() {
  return (
    <Suspense>
      <Connected />
    </Suspense>
  );
}
