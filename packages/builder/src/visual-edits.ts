import type { AuthorizedClient } from "@locus/auth";
import {
  applyVisualEdits,
  draftFingerprint,
  type VisualEdit,
  type VisualEditFailure,
  WorkspaceError,
} from "@locus/studio";
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
  /** The draft's fingerprint after the save, for the next save from the same preview. */
  draft: string;
}

/** Said when the preview was made from older files than the draft has now. */
export const PREVIEW_OUT_OF_DATE =
  "The site changed since this preview loaded. Reload the preview and make the change again.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Saves changes a person made by clicking things in the site's preview (Visual edits) as a new
 * version, with no AI involved: each edit is applied to the draft where the preview said the
 * element is (`applyVisualEdits`), the draft is saved as an "edit" version, the version goes
 * to the site's repository as a chat save would, and the preview is brought up to date.
 *
 * `client` must come from `resolveActiveClient` / `authorizeClient` for the signed-in session;
 * the staff check runs again and the site must be that client's, exactly as for the chat.
 * `draft` is the fingerprint the preview was made from (`draftFingerprint`): the edits name
 * places in those files, so a draft that has changed since refuses them all.
 */
export async function saveVisualEdits(
  deps: SiteBuilderDeps,
  client: AuthorizedClient,
  siteId: string,
  edits: VisualEdit[],
  draft: string,
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
    const snapshot = await workspace.snapshot();
    if (draftFingerprint(snapshot) !== draft) throw new WorkspaceError(PREVIEW_OUT_OF_DATE);
    const result = applyVisualEdits(snapshot, edits);
    if (result.files.length === 0) {
      return { version: null, applied: 0, failed: result.failed, draft };
    }
    // The site builder may have changed one of these files since the snapshot: never write
    // over its change with an edit worked out from the older file.
    for (const file of result.files) {
      const before = snapshot.find((f) => f.path === file.path)?.content;
      if ((await workspace.readFile(file.path)) !== before) {
        throw new WorkspaceError(PREVIEW_OUT_OF_DATE);
      }
    }
    await workspace.writeFiles(result.files);
    const version = await workspace.saveVersion({
      message: `Visual edits: ${plural(result.applied, "change", "changes")}`,
      source: "edit",
      userId: session.userId ?? null,
    });
    const saved = await workspace.snapshot();
    let publishError: string | undefined;
    if (version && session.onVersionSaved) {
      try {
        const published = await session.onVersionSaved(version, saved);
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
      .then(async () =>
        syncRuntime(await session.runtime(), saved, {
          editorOrigins: session.editorOrigins ?? [],
        }),
      )
      .catch((error) => {
        console.error(`Syncing the preview after visual edits failed: ${String(error)}`);
      });
    return {
      version: version?.number ?? null,
      applied: result.applied,
      failed: result.failed,
      draft: draftFingerprint(saved),
      ...(publishError ? { publishError } : {}),
    };
  } finally {
    await Promise.resolve()
      .then(() => session.release?.())
      .catch(() => {});
  }
}
