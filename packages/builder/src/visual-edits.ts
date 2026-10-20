import type { AuthorizedClient } from "@locus/auth";
import { applyVisualEdits, type VisualEdit, type VisualEditFailure } from "@locus/studio";
import { CLIENT_KEY, createSiteBuilder, SITE_ID_KEY, type SiteBuilderDeps } from "./host.ts";
import { syncRuntime } from "./sync.ts";
import { PublishError } from "./tools.ts";

export interface VisualEditsSaved {
  /** The new version's number, or null when nothing could be applied. */
  version: number | null;
  applied: number;
  failed: VisualEditFailure[];
  /** Set when the version is saved but couldn't be sent to the site's repository. */
  publishError?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Saves changes a person made by clicking things in the site's preview (Visual edits) as a new
 * version, with no AI involved: each edit is applied to the draft where the preview said the
 * element is (`applyVisualEdits`), the draft is saved as an "edit" version, the version goes
 * to the site's repository as a chat save would, and the preview is brought up to date.
 *
 * `client` must come from `resolveActiveClient` / `authorizeClient` for the signed-in session;
 * the staff check runs again and the site must be that client's, exactly as for the chat.
 */
export async function saveVisualEdits(
  deps: SiteBuilderDeps,
  client: AuthorizedClient,
  siteId: string,
  edits: VisualEdit[],
): Promise<VisualEditsSaved> {
  const { resolve } = createSiteBuilder(deps, { client });
  const session = await resolve(
    new Map<string, unknown>([
      [SITE_ID_KEY, siteId],
      [CLIENT_KEY, client],
    ]),
  );
  try {
    const { workspace } = session;
    const result = applyVisualEdits(await workspace.snapshot(), edits);
    if (result.files.length === 0) {
      return { version: null, applied: 0, failed: result.failed };
    }
    await workspace.writeFiles(result.files);
    const version = await workspace.saveVersion({
      message: `Visual edits: ${plural(result.applied, "change", "changes")}`,
      source: "edit",
      userId: session.userId ?? null,
    });
    let publishError: string | undefined;
    if (version && session.onVersionSaved) {
      try {
        const published = await session.onVersionSaved(version, await workspace.snapshot());
        if (published?.commitSha) {
          await workspace.setCommitSha(version.id, published.commitSha).catch(() => {});
        }
      } catch (error) {
        publishError =
          error instanceof PublishError
            ? error.message
            : "Saved, but it couldn't be sent to the site's repository. Try publishing again later.";
      }
    }
    // The person is looking at the preview: show them the saved page. The save stands even
    // if the sandbox can't be reached; the next preview start syncs it.
    await Promise.resolve()
      .then(async () => syncRuntime(await session.runtime(), await workspace.snapshot()))
      .catch((error) => {
        console.error(`Syncing the preview after visual edits failed: ${String(error)}`);
      });
    return {
      version: version?.number ?? null,
      applied: result.applied,
      failed: result.failed,
      ...(publishError ? { publishError } : {}),
    };
  } finally {
    await Promise.resolve()
      .then(() => session.release?.())
      .catch(() => {});
  }
}
