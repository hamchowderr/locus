import type { Client } from "@libsql/client";

/**
 * A libSQL client whose token is renewed before it expires. Client databases are reached with
 * short-lived tokens that name only that database, but the agent keeps one store per client
 * for as long as the process runs; this opens a client with a fresh token every `renewMs`.
 *
 * The client it replaces stays in use until the new one has opened, and is closed `graceMs`
 * after that, so a query already running on it can finish (a transaction held longer than
 * that is cut off). If a renewal fails, the current client keeps serving and the renewal is
 * tried again after `retryMs`, unless the failure says access is gone (`revoked`): then the
 * current client is closed too.
 */
export function refreshingClient(
  open: () => Promise<Client>,
  {
    renewMs,
    graceMs = 60_000,
    retryMs = 30_000,
    revoked = () => false,
    now = Date.now,
  }: {
    renewMs: number;
    graceMs?: number;
    retryMs?: number;
    /** A renewal error meaning access is gone: the current client is closed, not kept. */
    revoked?: (error: unknown) => boolean;
    now?: () => number;
  },
): Client {
  let current: Client | undefined;
  let renewAt = 0;
  let opening: Promise<Client> | undefined;
  let closed = false;

  const renew = () => {
    opening ??= open().then(
      (fresh) => {
        const previous = current;
        current = fresh;
        renewAt = now() + renewMs;
        opening = undefined;
        if (previous) setTimeout(() => previous.close(), graceMs).unref?.();
        if (closed) fresh.close();
        return fresh;
      },
      (error: unknown) => {
        opening = undefined;
        renewAt = now() + retryMs;
        if (revoked(error)) {
          current?.close();
          current = undefined;
        }
        throw error;
      },
    );
    return opening;
  };

  const client = async (): Promise<Client> => {
    if (closed) throw new Error("the client is closed");
    if (!current) return renew();
    if (now() >= renewAt) {
      // Keep serving from the current client; a failed renewal is retried later.
      renew().catch((error: unknown) => {
        if (!revoked(error)) console.error(`Database token renewal failed: ${String(error)}`);
      });
    }
    return current;
  };

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
      current?.close();
    },
    reconnect: () => {
      current?.reconnect();
    },
    get closed() {
      return closed;
    },
    get protocol() {
      return current?.protocol ?? "unknown";
    },
  };
}
