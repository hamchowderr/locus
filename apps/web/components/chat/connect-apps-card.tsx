'use client';

import { CheckIcon, PlugIcon } from 'lucide-react';
import { useState } from 'react';
import { useConnectPopup } from '@/app/(app)/apps/use-connect-popup';
import { Button } from '@/components/ui/button';

const NAMES: Record<string, string> = {
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  slack: 'Slack',
};

/** The app's name for a toolkit slug: a known one, or the slug with a capital. */
export const appName = (toolkit: string) =>
  NAMES[toolkit.toLowerCase()] ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1);

/**
 * Shown in the chat when the AI needs an app the client hasn't connected: a Connect button per
 * app, signing in through the same pop-up as the Apps page. Once one connects, `onConnected`
 * lets the chat carry on.
 */
export function ConnectAppsCard({
  toolkits,
  onConnected,
}: {
  toolkits: string[];
  onConnected: (toolkit: string) => void;
}) {
  const [connected, setConnected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { connect, busy } = useConnectPopup({
    onDone: ({ toolkit, status }) => {
      if (!toolkits.includes(toolkit) || connected.includes(toolkit)) return;
      if (status === 'failed') {
        setError(`${appName(toolkit)}'s sign-in didn't finish. Try again.`);
        return;
      }
      setConnected((list) => [...list, toolkit]);
      onConnected(toolkit);
    },
    onError: setError,
  });

  return (
    <div className="my-2 space-y-2 rounded-md border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <PlugIcon className="size-4" /> Connect an app to continue
      </p>
      <div className="flex flex-wrap gap-2">
        {toolkits.map((toolkit) =>
          connected.includes(toolkit) ? (
            <span key={toolkit} className="flex items-center gap-1 text-muted-foreground">
              <CheckIcon className="size-4" /> {appName(toolkit)} connected
            </span>
          ) : (
            <Button
              key={toolkit}
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setError(null);
                if (!connect(toolkit)) {
                  setError('Your browser blocked the sign-in window. Allow pop-ups, or use the Connectors page.');
                }
              }}
            >
              {busy === toolkit ? 'Connecting…' : `Connect ${appName(toolkit)}`}
            </Button>
          ),
        )}
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
