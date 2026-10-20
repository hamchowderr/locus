/**
 * Connected apps through Composio (https://composio.dev). Composio keeps each app's sign-in and
 * runs its tools; Locus holds one Composio API key for Otaku's project.
 *
 * Each Locus client is one Composio user (`appUserId`), so a client's chat can only ever use
 * the accounts that client connected. The session is built for that user with Locus's allowed
 * apps only, can't create sign-in links (connecting happens on the Connections page, by a
 * person), and never falls back to Composio-owned "Instant" accounts, which Composio charges for.
 */

import { Composio } from "@composio/core";
import { APP_TOOLKITS, type AppConnector, type AppTool } from "./apps.ts";

/** The Composio user a Locus client's connections belong to. */
export function appUserId(clientId: string): string {
  if (!clientId) throw new Error("connected apps need a client");
  return `locus-client:${clientId}`;
}

export interface ComposioConnectorConfig {
  apiKey: string;
  /** The Locus client (one GHL location) whose apps these are; from the session, never a request. */
  clientId: string;
  /** Composio's API, for tests; defaults to Composio's own. */
  baseURL?: string;
}

const READ_ONLY_TAG = "readOnlyHint";

export function createComposioConnector({
  apiKey,
  clientId,
  baseURL,
}: ComposioConnectorConfig): AppConnector {
  const composio = new Composio({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    allowTracking: false,
    disableVersionCheck: true,
  });
  const userId = appUserId(clientId);
  let session: ReturnType<typeof open> | undefined;
  const open = () =>
    composio.create(userId, {
      toolkits: [...APP_TOOLKITS],
      manageConnections: false,
      instant: false,
    });
  const current = () => {
    session ??= open().catch((error) => {
      // A failed start isn't kept: the next call tries again.
      session = undefined;
      throw error;
    });
    return session;
  };
  // Tool metadata is Composio's own description of the tool, not anyone's data.
  const readOnly = new Map<string, Promise<boolean>>();

  return {
    async search(query) {
      const found = await (await current()).search({ query, toolkits: [...APP_TOOLKITS] });
      const slugs = new Set(
        found.results.flatMap((r) => [...r.primaryToolSlugs, ...r.relatedToolSlugs]),
      );
      const tools: AppTool[] = [...slugs].flatMap((slug) => {
        const schema = found.toolSchemas[slug];
        if (!schema) return [];
        return [
          {
            slug,
            toolkit: schema.toolkit,
            description: schema.description ?? "",
            inputSchema: schema.inputSchema ?? {},
          },
        ];
      });
      const notConnected = found.toolkitConnectionStatuses
        .filter((status) => !status.hasActiveConnection)
        .map((status) => status.toolkit);
      return { tools, notConnected };
    },

    readOnly(slug) {
      let known = readOnly.get(slug);
      if (!known) {
        known = composio.tools
          .getRawComposioToolBySlug(slug)
          .then((tool) => (tool.tags ?? []).includes(READ_ONLY_TAG));
        // Only answers are kept; a failed lookup is asked again next time.
        known.catch(() => readOnly.delete(slug));
        readOnly.set(slug, known);
      }
      return known;
    },

    async execute(slug, args) {
      const result = await (await current()).execute(slug, args);
      if (result.resultType === "completed") return { ok: true, data: result.data };
      return { ok: false, error: result.error || `${slug} failed` };
    },
  };
}
