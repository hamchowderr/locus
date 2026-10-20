import type { AuthorizedClient, SessionContext } from "@locus/auth";
import {
  ConnectError,
  ensureSiteDeployment,
  ensureSiteRepo,
  type InstallationRepo,
  type PublishDeps,
  type SiteRow,
} from "@locus/connect";
import { publishLatestVersion, type SiteBuilderDeps, SiteInputError } from "./site-builder.ts";

// The Sites page's publishing steps for an owner or admin: give a site a GitHub repository in
// the agency's account, then a project on the agency's Vercel team that builds it. The client
// is always the session's (after the staff check); the form only names one of its sites, and
// `@locus/connect` checks that site against the client and the caller's role again.

/** What the repository form sends: an existing repository to link, or a name for a new one. */
export interface RepoChoice {
  siteId: string;
  /** An existing repository's full name to link; empty to create a new one. */
  repo: string;
  /** The new repository's name, when `repo` is empty. */
  name: string;
}

/** The form's choice as `ensureSiteRepo`'s input. */
export function repoInput(choice: RepoChoice): Parameters<typeof ensureSiteRepo>[3] {
  const repo = choice.repo.trim();
  if (repo) return { siteId: choice.siteId, repoFullName: repo };
  const name = choice.name.trim();
  if (!name) throw new ConnectError("Name the new repository, or pick one to link.");
  return { siteId: choice.siteId, name };
}

/** Gives the client's site a GitHub repository, new or linked. Owners and admins only. */
export async function giveSiteRepo(
  deps: PublishDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  choice: RepoChoice,
): Promise<SiteRow> {
  return ensureSiteRepo(deps, ctx, client, repoInput(choice));
}

/**
 * The Sites page's repository step: gives the site its repository (`giveSiteRepo`), then sends
 * its latest version there straight away, so the Vercel project created next builds the site
 * instead of failing on an empty repository. If that first publish is refused, the repository
 * stays linked and the refusal comes back for the page.
 */
export async function giveSiteRepoAndPublish(
  deps: PublishDeps,
  builder: Pick<SiteBuilderDeps, "db" | "openClientDb" | "publish" | "locusUrl">,
  ctx: SessionContext,
  client: AuthorizedClient,
  choice: RepoChoice,
): Promise<SiteRow> {
  const row = await giveSiteRepo(deps, ctx, client, choice);
  try {
    await publishLatestVersion(builder, ctx, client, row.id);
  } catch (error) {
    if (!(error instanceof SiteInputError)) throw error;
    throw new ConnectError(
      `The repository is linked, but the site wasn't sent to it yet: ${error.message} Press Publish to try again.`,
    );
  }
  return row;
}

/** Gives the client's site a Vercel project that builds its repository. Owners and admins only. */
export async function giveSiteProject(
  deps: PublishDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteRow> {
  return ensureSiteDeployment(deps, ctx, client, { siteId });
}

/** A starting name for a site's new repository, from its name: `Bright Smiles` → `bright-smiles`. */
export function suggestedRepoName(siteName: string | undefined): string {
  const name = (siteName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100)
    .replace(/[-._]+$/g, "");
  return name || "site";
}

/** The repositories a site could link: those not already one of this client's sites. */
export function linkableRepos(
  repos: InstallationRepo[],
  sites: Pick<SiteRow, "repoFullName">[],
): InstallationRepo[] {
  const taken = new Set(sites.map((s) => s.repoFullName?.toLowerCase()).filter(Boolean));
  return repos.filter((r) => !taken.has(r.fullName.toLowerCase()));
}

/** Vercel's deployment states, for people. */
export const DEPLOYMENT_STATES: Record<string, string> = {
  QUEUED: "Queued",
  INITIALIZING: "Starting",
  BUILDING: "Building",
  READY: "Live",
  ERROR: "Build failed",
  CANCELED: "Canceled",
};

export const deploymentLabel = (state: string) => DEPLOYMENT_STATES[state] ?? state;
