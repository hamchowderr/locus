import type { AuthorizedClient } from "@locus/auth";
import Link from "next/link";
import { RefreshWhenShown } from "@/components/refresh-when-shown";
import { brainDeps, brainOverview } from "@/lib/brain";
import { NotConfigured } from "@/lib/locus";

const noteHref = (path: string) => `/brain?note=${encodeURIComponent(path)}`;

/**
 * The chat's Brain tab: the sub-account's notes by folder, each opening on the Brain page to read,
 * edit or put back. Read on the server when the chat page loads, and again each time it's shown,
 * so notes the agent saved in the meantime appear.
 */
export async function BrainTab({ client }: { client: AuthorizedClient }) {
  const overview = await Promise.resolve()
    .then(() => brainOverview(brainDeps(), client))
    .catch((e) => {
      // Without client databases there is no brain; that must not take the chat page down.
      if (e instanceof NotConfigured) return null;
      console.error("Brain tab: reading the notes failed", e);
      return null;
    });
  if (!overview) {
    return (
      <p className="px-2 text-pretty text-xs text-muted-foreground">
        The sub-account&apos;s notes couldn&apos;t be read just now.
      </p>
    );
  }
  const folders = overview.folders.filter((f) => f.notes.length > 0);

  return (
    <RefreshWhenShown className="flex flex-col gap-3">
      <Link
        href={noteHref("instructions.md")}
        className="rounded-md px-2 py-2 transition-colors hover:bg-muted"
      >
        <span className="block text-sm font-medium">Instructions</span>
        <span className="block truncate text-xs text-muted-foreground">
          {overview.instructions?.summary ||
            "How agents work for this sub-account. Not written yet."}
        </span>
      </Link>
      {folders.length === 0 ? (
        <p className="px-2 text-pretty text-xs text-muted-foreground">
          What the agent learns about this business beyond GoHighLevel shows up here: hours,
          pricing, how jobs are done, decisions. Tell it something in the chat and it saves a note.
        </p>
      ) : (
        folders.map((folder) => (
          <section key={folder.name} className="flex flex-col">
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {folder.name}
            </h3>
            <ul className="flex flex-col">
              {folder.notes.map((n) => (
                <li key={n.path}>
                  <Link
                    href={noteHref(n.path)}
                    className="block rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
                  >
                    <span className="block truncate text-sm">{n.name}</span>
                    {n.summary && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {n.summary}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <Link href="/brain" className="px-2 text-xs text-muted-foreground underline">
        Open the Brain
      </Link>
    </RefreshWhenShown>
  );
}
