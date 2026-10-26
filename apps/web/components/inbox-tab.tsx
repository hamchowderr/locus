import { type AuthorizedClient, inboxDraftsFor } from "@locus/auth";
import { type InboxConversation, listInbox } from "@locus/connect";
import Link from "next/link";
import { RefreshWhenShown } from "@/components/refresh-when-shown";
import { Badge } from "@/components/ui/badge";
import { connectDeps } from "@/lib/connect";
import { locus, NotConfigured } from "@/lib/locus";

/** Where GoHighLevel opens one of the sub-account's conversations. */
const ghlConversationUrl = (ghlLocationId: string, conversationId: string) =>
  `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/conversations/conversations/${encodeURIComponent(conversationId)}`;

const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/**
 * The chat's Inbox tab: the sub-account's latest GHL conversations, read live from GHL when the
 * chat page loads (and again each time the tab is shown), never stored. Whether new messages get
 * a drafted reply is said at the top; the drafts themselves are threads, under Threads.
 */
export async function InboxTab({ client }: { client: AuthorizedClient }) {
  const drafting = (await inboxDraftsFor(locus().db, client.location.id)) !== null;
  const conversations = await listInbox(connectDeps(), client).catch(
    (e: unknown): InboxConversation[] | null => {
      if (!(e instanceof NotConfigured)) {
        // The error only: what GHL sent back may quote the sub-account's data.
        console.error("Inbox tab: reading conversations from GHL failed", (e as Error)?.name);
      }
      return null;
    },
  );

  return (
    <RefreshWhenShown className="flex flex-col gap-3">
      <p className="px-2 text-pretty text-xs text-muted-foreground">
        {drafting ? (
          <>New messages get a drafted reply in a thread, sent only after someone approves it.</>
        ) : (
          <>
            Drafted replies are off for this sub-account. An owner or admin can turn them on under{" "}
            <Link href="/clients" className="underline">
              Sub-accounts
            </Link>
            .
          </>
        )}
      </p>
      {conversations === null ? (
        <p className="px-2 text-pretty text-xs text-muted-foreground">
          GoHighLevel didn&apos;t answer just now, so the inbox can&apos;t be shown. Try again in a
          moment.
        </p>
      ) : conversations.length === 0 ? (
        <p className="px-2 text-pretty text-xs text-muted-foreground">
          No conversations yet. Messages from contacts show up here as they come in.
        </p>
      ) : (
        <ul className="flex flex-col">
          {conversations.map((c) => (
            <li key={c.id}>
              <InboxRow conversation={c} ghlLocationId={client.location.ghlLocationId} />
            </li>
          ))}
        </ul>
      )}
    </RefreshWhenShown>
  );
}

function InboxRow({
  conversation: c,
  ghlLocationId,
}: {
  conversation: InboxConversation;
  ghlLocationId: string;
}) {
  return (
    <a
      href={ghlConversationUrl(ghlLocationId, c.id)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in GoHighLevel"
      className="flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-muted"
    >
      <span className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${c.unread > 0 ? "font-semibold" : "font-medium"}`}
        >
          {c.contact}
        </span>
        {c.unread > 0 && (
          <Badge>
            <span className="sr-only">Unread: </span>
            {c.unread}
          </Badge>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {c.channel}
        {c.at && (
          <>
            {" · "}
            <time dateTime={c.at.toISOString()}>{when.format(c.at)}</time>
          </>
        )}
      </span>
      {c.preview && <span className="line-clamp-2 text-xs text-muted-foreground">{c.preview}</span>}
    </a>
  );
}
