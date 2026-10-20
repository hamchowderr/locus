/**
 * How an app's sign-in tells the Apps page it came back. Composio's sign-in page may open
 * Locus in a new tab rather than in the pop-up, so this goes over a same-origin
 * BroadcastChannel that reaches every Locus tab, not to `window.opener`.
 */
export const CONNECTED_CHANNEL = "locus:app-connected";

export type ConnectedMessage = {
  toolkit: string;
  /** Composio's `status` on the way back: `success` or `failed`. */
  status: string;
};

export function connectedPath({ toolkit, status }: ConnectedMessage): string {
  return status === "failed"
    ? `/apps?error=${encodeURIComponent("The app's sign-in didn't finish. Try again.")}`
    : `/apps?connected=${encodeURIComponent(toolkit)}`;
}
