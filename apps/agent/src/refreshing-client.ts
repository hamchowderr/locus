import type { Client } from "@libsql/client";

/**
 * A libSQL client whose token is renewed before it expires. Client databases are reached with
 * short-lived tokens that name only that database, but the agent keeps one store per client
 * for as long as the process runs; this swaps in a client with a fresh token every `renewMs`.
 * The client it replaces is closed after `graceMs`, so a query or transaction already running
 * on it can finish.
 */
export function refreshingClient(
  open: () => Promise<Client>,
  {
    renewMs,
    graceMs = 60_000,
    now = Date.now,
  }: {
    renewMs: number;
    graceMs?: number;
    now?: () => number;
  },
): Client {
  let current: Promise<Client> | undefined;
  let openedAt = 0;
  const client = (): Promise<Client> => {
    if (!current || now() - openedAt >= renewMs) {
      const previous = current;
      openedAt = now();
      const opening = open();
      current = opening;
      // A failed open must not stick: the next call tries again.
      opening.catch(() => {
        if (current === opening) current = undefined;
      });
      previous?.then(
        (old) => setTimeout(() => old.close(), graceMs).unref?.(),
        () => {},
      );
    }
    return current;
  };
  let closed = false;
  return {
    execute: (async (...args: unknown[]) =>
      (await client()).execute(...(args as [never]))) as Client["execute"],
    batch: (async (...args: Parameters<Client["batch"]>) =>
      (await client()).batch(...args)) as Client["batch"],
    migrate: (async (...args: Parameters<Client["migrate"]>) =>
      (await client()).migrate(...args)) as Client["migrate"],
    transaction: (async (...args: Parameters<Client["transaction"]>) =>
      (await client()).transaction(...args)) as Client["transaction"],
    executeMultiple: async (sql) => (await client()).executeMultiple(sql),
    sync: async () => (await client()).sync(),
    close: () => {
      closed = true;
      current?.then(
        (c) => c.close(),
        () => {},
      );
    },
    reconnect: () => {
      current?.then(
        (c) => c.reconnect(),
        () => {},
      );
    },
    get closed() {
      return closed;
    },
    protocol: "https",
  };
}
