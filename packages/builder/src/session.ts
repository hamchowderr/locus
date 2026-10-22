import type { SiteCrm } from "@locus/connect";
import type { SiteRuntime } from "@locus/sandbox";
import type { SiteFile, SiteWorkspace, VersionInfo } from "@locus/studio";
import type { ImageGenerator } from "./images.ts";

/** What the builder spends, in the units the usage meter prices. */
export type BuilderUsage =
  | { kind: "image"; count: number; size: "small" | "medium" | "large"; model: string }
  | { kind: "sandbox"; seconds: number };

/** Credit metering for one sub-account, implemented by the host with `@locus/auth`. */
export interface UsageMeter {
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  record(usage: BuilderUsage): Promise<void>;
}

/**
 * Everything one site-building conversation acts on, resolved by the host from the signed-in
 * session: the client from the session, the site checked against that client, and the client's
 * own database. Nothing the model says can change any of it.
 */
export interface BuilderSession {
  workspace: SiteWorkspace;
  /** The site's sandbox, opened on first use. */
  runtime: () => Promise<SiteRuntime>;
  images?: ImageGenerator | null;
  /** Reads from the client's GHL sub-account (calendars, media), for this client only. */
  crm?: SiteCrm | null;
  meter?: UsageMeter | null;
  userId?: string | null;
  /**
   * The Locus web app's origins, the only pages the preview's visual-edits script answers.
   * Empty or missing: the preview can't be edited by clicking.
   */
  editorOrigins?: string[];
  /**
   * Called once the tool call that resolved this session has finished, successfully or not,
   * e.g. to release a pooled database connection.
   */
  release?: () => void | Promise<void>;
  /** Called after each saved version, e.g. to commit it to the agency's repository. */
  onVersionSaved?: (
    version: VersionInfo,
    files: SiteFile[],
  ) => Promise<{ commitSha?: string; url?: string } | undefined>;
}

/** What a tool call knows of its run beyond the request context: the conversation it is in. */
export interface BuilderRun {
  /** The thread the call runs in, from Mastra's own tool context (never from a request). */
  threadId?: string | undefined;
}

/** Looks up the session for a tool call from the host-set request context and its run. */
export type ResolveBuilderSession = (
  requestContext: unknown,
  run?: BuilderRun,
) => Promise<BuilderSession>;
