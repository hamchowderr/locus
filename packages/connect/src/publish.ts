import { createPrivateKey, randomUUID, sign } from "node:crypto";
import {
  type AuthorizedClient,
  assertAuthorizedClient,
  requireAgencyManager,
  type SessionContext,
} from "@locus/auth";
import type { TenantProvisioner } from "@locus/db";
import { auditLog, githubInstallation, site } from "@locus/db/control";
import { and, eq, isNull, ne } from "drizzle-orm";
import { ConnectError } from "./errors.ts";
import { GITHUB_API_VERSION, type GithubHttp } from "./github.ts";
import { ensureSiteBackendEnv } from "./site-backend.ts";
import { audit, type SiteDeps, type SiteRow } from "./sites.ts";
import { hostGrant, refused, type VercelResult, vercel } from "./vercel-api.ts";

// Publishing a client's generated site: each saved version is committed to a repository in the
// agency's own GitHub account (through the Locus GitHub App's installation), and a project on
// the agency's own Vercel team builds that repository.
//
// GitHub contracts read on 2026-10-14 (docs.github.com through search; the pages themselves
// could not be fetched from this environment): generating a JWT for a GitHub App (RS256, `iat`
// 60 s in the past, `exp` at most 10 minutes ahead, `iss` the client ID — recommended — or the
// app ID), `POST /app/installations/{id}/access_tokens` (optional `repositories` and
// `permissions`; tokens last one hour), `GET /app/installations/{id}`,
// `GET /installation/repositories`, `POST /orgs/{org}/repos`, the Git database API (blobs,
// trees, commits, refs), which answers 409 while a repository is empty, and
// `PUT /repos/{owner}/{repo}/contents/{path}`, which GitHub's guide gives as the way to put the
// first commit in an empty repository.
//
// Vercel contracts read on 2026-10-14 (vercel.com/docs through search): `POST /v11/projects`
// (`name`, `framework`, `gitRepository: { type, repo }`; team in the query, never the body),
// `GET /v6/deployments` (`projectId`, `limit`, `target`; a deployment's `url` is a hostname,
// null until it has finished uploading, and sits behind deployment protection by default),
// `GET /v9/projects/{id}` (its production aliases; `<name>.vercel.app` unless configured
// otherwise) and `POST /v13/deployments` with a `gitSource`.

/**
 * The Locus GitHub App's own credentials. The private key is never an environment variable:
 * the deployment's secret loader supplies it, and Locus asks for it only to sign a JWT.
 */
export interface GithubAppCredentials {
  /** Used as the JWT's `iss`: the app's client ID (GitHub's recommendation) or its app ID. */
  appId: string;
  /** The app's PEM private key. Called each time a JWT is signed; nothing keeps it. */
  privateKey: () => Promise<string>;
}

/** Installation tokens by installation, repository and permissions, until near expiry. */
export class InstallationTokenCache {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();

  get(key: string, now: number): string | undefined {
    const hit = this.#tokens.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt - now > TOKEN_MARGIN_MS) return hit.token;
    this.#tokens.delete(key);
    return undefined;
  }

  set(key: string, token: string, expiresAt: number): void {
    this.#tokens.set(key, { token, expiresAt });
  }
}

/** A token is renewed this long before GitHub says it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

const defaultTokenCache = new InstallationTokenCache();

export interface PublishDeps extends SiteDeps {
  githubApp: GithubAppCredentials;
  /** Reaches app-style sites' own databases (`site-backend.ts`). Plain websites don't need it. */
  provisioner?: TenantProvisioner;
  /** App-style sites' files keys (`siteFilesKey`); absent where Locus has no file storage. */
  siteFilesKey?: (siteId: string) => string;
  /** GitHub's API (`fetch`, `apiBaseUrl`). `http` is Vercel's, as for sites. */
  github?: GithubHttp;
  /** Defaults to one cache per process. */
  tokens?: InstallationTokenCache;
  now?: () => number;
}

type Permissions = Partial<Record<"contents" | "administration" | "metadata", "read" | "write">>;

const nowOf = (deps: Pick<PublishDeps, "now">) => deps.now?.() ?? Date.now();

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** The app's JWT: RS256, issued 60 s ago for clock drift, valid 9 minutes (GitHub allows 10). */
export async function createAppJwt(app: GithubAppCredentials, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 600, iss: app.appId }));
  const key = createPrivateKey(await app.privateKey());
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

interface GithubResult<T> {
  ok: boolean;
  status: number;
  body: T & { message?: string };
}

async function github<T>(
  deps: Pick<PublishDeps, "github">,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GithubResult<T>> {
  const { fetch: f = fetch, apiBaseUrl = "https://api.github.com" } = deps.github ?? {};
  const response = await f(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${auth}`,
      "x-github-api-version": GITHUB_API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as GithubResult<T>["body"];
  return { ok: response.ok, status: response.status, body: parsed };
}

function githubRefused(result: GithubResult<unknown>, fallback: string): ConnectError {
  if (result.status === 401 || result.status === 403) {
    return new ConnectError(
      "GitHub refused. Check on GitHub that the Locus app is still installed and has access to the site's repository.",
    );
  }
  return new ConnectError(result.body.message ? `GitHub: ${result.body.message}` : fallback);
}

/**
 * An installation token, from the cache while it has more than five minutes left. Scoped to
 * one repository and to the permissions asked for, so each call holds only what it needs.
 */
export async function installationToken(
  deps: Pick<PublishDeps, "githubApp" | "github" | "tokens" | "now">,
  installationId: string,
  scope: { repository?: string; permissions: Permissions },
): Promise<string> {
  const cache = deps.tokens ?? defaultTokenCache;
  const key = JSON.stringify([
    deps.githubApp.appId,
    installationId,
    scope.repository ?? "*",
    Object.entries(scope.permissions).sort(),
  ]);
  const cached = cache.get(key, nowOf(deps));
  if (cached) return cached;

  const jwt = await createAppJwt(deps.githubApp, nowOf(deps));
  const result = await github<{ token?: string; expires_at?: string }>(
    deps,
    jwt,
    "POST",
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      ...(scope.repository ? { repositories: [scope.repository] } : {}),
      permissions: scope.permissions,
    },
  );
  if (result.status === 404) {
    throw new ConnectError("The Locus GitHub app is no longer installed. Connect GitHub again.");
  }
  if (!result.ok || !result.body.token) {
    throw githubRefused(result, "GitHub didn't let Locus act on the installation. Try again.");
  }
  const expiresAt = Date.parse(result.body.expires_at ?? "") || nowOf(deps) + 60 * 60_000;
  cache.set(key, result.body.token, expiresAt);
  return result.body.token;
}

async function agencyInstallation(deps: PublishDeps, organizationId: string) {
  const [row] = await deps.db
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.organizationId, organizationId));
  if (!row) throw new ConnectError("Connect GitHub on the Integrations page first.");
  return row;
}

/** The client's site, looked up by id and the client from the session together. */
async function clientSiteRow(
  deps: Pick<SiteDeps, "db">,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteRow> {
  const [row] = await deps.db
    .select()
    .from(site)
    .where(and(eq(site.id, siteId), eq(site.locationId, client.location.id)));
  if (!row) throw new ConnectError("That site isn't one of this client's.");
  return row;
}

function splitRepo(fullName: string): { owner: string; name: string; path: string } {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    owner,
    name,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  };
}

export interface InstallationRepo {
  fullName: string;
  private: boolean;
}

interface ApiRepo {
  full_name: string;
  private?: boolean;
  default_branch?: string;
}

/**
 * At most this many pages of 100 are read (1,000 repositories). An installation with more must
 * narrow the app's repository access before a site can be linked to one past the cap.
 */
const MAX_REPO_PAGES = 10;

async function installationRepos(deps: PublishDeps, installationId: string): Promise<ApiRepo[]> {
  const token = await installationToken(deps, installationId, {
    permissions: { metadata: "read" },
  });
  const all: ApiRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const result = await github<{ total_count?: number; repositories?: ApiRepo[] }>(
      deps,
      token,
      "GET",
      `/installation/repositories?per_page=100&page=${page}`,
    );
    if (!result.ok) throw githubRefused(result, "GitHub didn't list the repositories. Try again.");
    const batch = result.body.repositories ?? [];
    all.push(...batch);
    if (batch.length < 100 || all.length >= (result.body.total_count ?? 0)) break;
  }
  return all;
}

/** The repositories the agency gave the Locus app, for picking one for a site. */
export async function listInstallationRepos(
  deps: PublishDeps,
  ctx: SessionContext,
): Promise<InstallationRepo[]> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const installation = await agencyInstallation(deps, organizationId);
  return (await installationRepos(deps, installation.installationId)).map((r) => ({
    fullName: r.full_name,
    private: r.private ?? true,
  }));
}

/** The GitHub account an installation is on. */
export interface InstallationAccount {
  login: string;
  /**
   * A personal account rather than an organization. GitHub Apps can't create repositories
   * there, so each site's empty repository is made by hand and linked.
   */
  personal: boolean;
  installationId: string;
}

async function installationAccount(
  deps: PublishDeps,
  installationId: string,
): Promise<InstallationAccount> {
  const jwt = await createAppJwt(deps.githubApp, nowOf(deps));
  const about = await github<{ account?: { login?: string; type?: string } | null }>(
    deps,
    jwt,
    "GET",
    `/app/installations/${encodeURIComponent(installationId)}`,
  );
  if (about.status === 404) {
    throw new ConnectError("The Locus GitHub app is no longer installed. Connect GitHub again.");
  }
  if (!about.ok) throw githubRefused(about, "GitHub didn't show the installation. Try again.");
  const account = about.body.account;
  if (!account?.login) throw new ConnectError("GitHub didn't say which account Locus is on.");
  return { login: account.login, personal: account.type !== "Organization", installationId };
}

/** The account the agency's GitHub installation is on, for the Sites page. Owners and admins. */
export async function agencyGithubAccount(
  deps: PublishDeps,
  ctx: SessionContext,
): Promise<InstallationAccount> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const installation = await agencyInstallation(deps, organizationId);
  return installationAccount(deps, installation.installationId);
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Gives the client's site a GitHub repository in the agency's account, once. Owners and admins
 * only.
 *
 * - `{ name }` creates a private, empty repository in the organization Locus is installed on.
 *   GitHub Apps can't create repositories in a personal account, so there the agency creates
 *   an empty one itself, gives the app access, and links it instead.
 * - `{ repoFullName }` links a repository the installation can already access, in any account.
 *   Each save replaces the repository's files with the site's, so it should be empty.
 */
export async function ensureSiteRepo(
  deps: PublishDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string } & ({ name: string } | { repoFullName: string }),
): Promise<SiteRow> {
  assertAuthorizedClient(client);
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const row = await clientSiteRow(deps, client, input.siteId);
  if (row.repoFullName) return row;
  const installation = await agencyInstallation(deps, organizationId);

  let repoFullName: string;
  let action: string;
  if ("repoFullName" in input) {
    const wanted = input.repoFullName.trim().toLowerCase();
    const found = (await installationRepos(deps, installation.installationId)).find(
      (r) => r.full_name.toLowerCase() === wanted,
    );
    if (!found) {
      throw new ConnectError(
        "The Locus GitHub app can't see that repository. On GitHub, give the app access to it, then try again.",
      );
    }
    repoFullName = found.full_name;
    action = "site.repo.link";
  } else {
    repoFullName = await createOrgRepo(deps, installation.installationId, input.name);
    action = "site.repo.create";
  }

  // Each save replaces the whole repository, so one repository is one site.
  const [taken] = await deps.db
    .select({ id: site.id })
    .from(site)
    .where(and(eq(site.repoFullName, repoFullName), ne(site.id, row.id)));
  if (taken) throw alreadyAnotherSite();
  if (action === "site.repo.link") {
    await assertRepoEmpty(deps, installation.installationId, repoFullName);
  }

  // Only while the site has no repository; the unique index stops a second site taking it.
  const [updated] = await deps.db
    .update(site)
    .set({ repoFullName })
    .where(and(eq(site.id, row.id), isNull(site.repoFullName)))
    .returning()
    .catch((error: unknown) => {
      const text = `${error} ${(error as { cause?: unknown })?.cause ?? ""}`;
      if (/UNIQUE constraint failed/i.test(text)) throw alreadyAnotherSite();
      throw error;
    });
  if (!updated) {
    // A concurrent request gave this site its repository first: it is already linked.
    return clientSiteRow(deps, client, row.id);
  }
  await audit(deps.db, ctx, client, action, { siteId: row.id, repoFullName });
  return updated;
}

const alreadyAnotherSite = () => new ConnectError("That repository is already another site's.");

/**
 * Refuses a repository with commits on its default branch: every save replaces the whole
 * tree, so linking it would wipe what is there. GitHub answers 409 for an empty repository.
 */
async function assertRepoEmpty(deps: PublishDeps, installationId: string, repoFullName: string) {
  const repo = splitRepo(repoFullName);
  const token = await installationToken(deps, installationId, {
    repository: repo.name,
    permissions: { contents: "read" },
  });
  const about = await github<{ default_branch?: string; size?: number }>(
    deps,
    token,
    "GET",
    repo.path,
  );
  if (!about.ok) throw githubRefused(about, "GitHub didn't show the repository. Try again.");
  const branch = about.body.default_branch || "main";
  const ref = await github(
    deps,
    token,
    "GET",
    `${repo.path}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (ref.status === 409) return;
  if (ref.status === 404 && !about.body.size) return;
  if (ref.ok || ref.status === 404) {
    throw new ConnectError(
      `${repoFullName} already has files, and each save replaces everything in the repository. Pick an empty repository, or create one.`,
    );
  }
  throw githubRefused(ref, "GitHub didn't show the repository's branch. Try again.");
}

async function createOrgRepo(
  deps: PublishDeps,
  installationId: string,
  rawName: string,
): Promise<string> {
  const name = rawName.trim();
  if (!REPO_NAME.test(name) || name === "." || name === "..") {
    throw new ConnectError(
      "Repository names use letters, numbers, dots, dashes and underscores, up to 100 characters.",
    );
  }
  const account = await installationAccount(deps, installationId);
  if (account.personal) {
    throw new ConnectError(
      `Locus can't create repositories in the personal account ${account.login}. Create an empty private repository there, give the Locus app access to it, and pick it here.`,
    );
  }

  const token = await installationToken(deps, installationId, {
    permissions: { administration: "write" },
  });
  const created = await github<{ full_name?: string }>(
    deps,
    token,
    "POST",
    `/orgs/${encodeURIComponent(account.login)}/repos`,
    { name, private: true, auto_init: false },
  );
  if (created.status === 422) {
    throw new ConnectError(
      `GitHub didn't create ${account.login}/${name}: the name is taken or not allowed. Pick another, or link the existing repository.`,
    );
  }
  if (!created.ok || !created.body.full_name) {
    throw githubRefused(created, "GitHub didn't create the repository. Try again.");
  }
  return created.body.full_name;
}

export interface SiteFile {
  path: string;
  content: string | Uint8Array;
  /** Set for a file that must stay executable (e.g. a script); otherwise a plain file. */
  executable?: boolean;
}

const modeOf = (file: SiteFile) => (file.executable ? "100755" : "100644");

/**
 * Throws unless every path is a plain relative path inside the repository. Generated code must
 * never commit secrets, so any `.env*` file is refused, as is anything under `.git/`.
 */
export function checkSitePaths(files: SiteFile[]): void {
  if (files.length === 0) throw new ConnectError("There are no files to publish.");
  const seen = new Set<string>();
  for (const { path } of files) {
    const segments = path.split("/");
    const bad =
      !path ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      segments.some((s) => s === "" || s === "." || s === "..") ||
      segments.some((s) => s.toLowerCase() === ".git");
    if (bad)
      throw new ConnectError(`Locus won't publish the file "${path}": the path isn't allowed.`);
    const file = (segments.at(-1) ?? "").toLowerCase();
    if (file.startsWith(".env")) {
      throw new ConnectError(
        `Locus won't publish "${path}": environment files can hold secrets and never go in the repository.`,
      );
    }
    if (seen.has(path)) throw new ConnectError(`"${path}" is in the version twice.`);
    seen.add(path);
  }
}

/**
 * Commits a full snapshot of the site's files to its repository's default branch, with the
 * branch's current commit as the parent. The tree is built without a base, so a file left out
 * of the snapshot is deleted. Pass `parentSha` (the commit the version was made from) to refuse
 * the save if the branch has moved since, or `null` to say the repository should still be
 * empty. Left out, the branch's current head is the parent, whatever it is.
 *
 * Anyone who may work on the client may save; the repository is reached with a token scoped to
 * it, with `contents: write` only.
 */
export async function commitSiteVersion(
  deps: PublishDeps,
  client: AuthorizedClient,
  input: { siteId: string; files: SiteFile[]; message: string; parentSha?: string | null },
): Promise<{ commitSha: string; url: string }> {
  assertAuthorizedClient(client);
  checkSitePaths(input.files);
  const message = input.message.trim() || "Update the site";
  const row = await clientSiteRow(deps, client, input.siteId);
  if (!row.repoFullName) throw new ConnectError("Give the site a GitHub repository first.");
  const installation = await agencyInstallation(deps, client.location.organizationId);
  const repo = splitRepo(row.repoFullName);
  const token = await installationToken(deps, installation.installationId, {
    repository: repo.name,
    permissions: { contents: "write" },
  });
  const call = <T>(method: string, path: string, body?: unknown) =>
    github<T>(deps, token, method, `${repo.path}${path}`, body);

  const about = await call<{ default_branch?: string }>("GET", "");
  if (about.status === 404) {
    throw new ConnectError(
      `Locus can't reach ${row.repoFullName} on GitHub. Check that the Locus app has access to it.`,
    );
  }
  if (!about.ok) throw githubRefused(about, "GitHub didn't show the repository. Try again.");
  const branch = about.body.default_branch || "main";
  const refPath = `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;

  // The branch's head: a commit, missing (404), or the repository is empty (409).
  const ref = await call<{ object?: { sha?: string } }>(
    "GET",
    refPath.replace("/git/refs/", "/git/ref/"),
  );
  let head: string | null;
  let refExists: boolean;
  if (ref.ok && ref.body.object?.sha) {
    head = ref.body.object.sha;
    refExists = true;
  } else if (ref.status === 404 || ref.status === 409) {
    head = null;
    refExists = false;
  } else {
    throw githubRefused(ref, "GitHub didn't show the repository's branch. Try again.");
  }
  if (input.parentSha !== undefined && input.parentSha !== head) {
    throw new ConnectError(
      "The site's repository changed since this version was started. Reload it and save again.",
    );
  }

  if (ref.status === 409) {
    // The Git database API refuses an empty repository; the contents API makes its first
    // commit, on the default branch. The full snapshot follows as its child.
    const first = [...input.files].sort((a, b) => a.path.localeCompare(b.path))[0] as SiteFile;
    const seeded = await call<{ commit?: { sha?: string } }>(
      "PUT",
      `/contents/${first.path.split("/").map(encodeURIComponent).join("/")}`,
      { message, content: Buffer.from(first.content).toString("base64") },
    );
    if (!seeded.ok || !seeded.body.commit?.sha) {
      throw githubRefused(seeded, "GitHub didn't take the first commit. Try again.");
    }
    head = seeded.body.commit.sha;
    refExists = true;
  }

  const tree: {
    path: string;
    mode: "100644" | "100755";
    type: "blob";
    sha?: string;
    content?: string;
  }[] = [];
  for (const file of input.files) {
    if (typeof file.content === "string") {
      tree.push({ path: file.path, mode: modeOf(file), type: "blob", content: file.content });
      continue;
    }
    const blob = await call<{ sha?: string }>("POST", "/git/blobs", {
      content: Buffer.from(file.content).toString("base64"),
      encoding: "base64",
    });
    if (!blob.ok || !blob.body.sha) throw githubRefused(blob, "GitHub didn't take a file.");
    tree.push({ path: file.path, mode: modeOf(file), type: "blob", sha: blob.body.sha });
  }
  // No `base_tree`: the tree is exactly the snapshot.
  const madeTree = await call<{ sha?: string }>("POST", "/git/trees", { tree });
  if (!madeTree.ok || !madeTree.body.sha) {
    throw githubRefused(madeTree, "GitHub didn't take the site's files.");
  }
  const commit = await call<{ sha?: string; html_url?: string }>("POST", "/git/commits", {
    message,
    tree: madeTree.body.sha,
    parents: head ? [head] : [],
  });
  if (!commit.ok || !commit.body.sha) throw githubRefused(commit, "GitHub didn't take the commit.");
  const commitSha = commit.body.sha;

  const moved = refExists
    ? await call("PATCH", refPath, { sha: commitSha, force: false })
    : await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commitSha });
  if (moved.status === 422) {
    throw new ConnectError(
      "The site's repository changed while saving. Reload the site and save again.",
    );
  }
  if (!moved.ok) throw githubRefused(moved, "GitHub didn't move the branch to the new commit.");

  if (row.status === "draft") {
    await deps.db.update(site).set({ status: "pushed" }).where(eq(site.id, row.id));
  }
  // No session here: the member who saved is recorded instead.
  await deps.db.insert(auditLog).values({
    id: randomUUID(),
    organizationId: client.location.organizationId,
    actorUserId: null,
    locationId: client.location.id,
    action: "site.commit",
    detail: {
      siteId: row.id,
      repoFullName: row.repoFullName,
      commitSha,
      memberId: client.memberId,
    },
  });
  return {
    commitSha,
    url: commit.body.html_url ?? `https://github.com/${row.repoFullName}/commit/${commitSha}`,
  };
}

/** Vercel project names: lower case, up to 100 characters, letters, digits, `.`, `_`, `-`. */
function projectName(repoName: string): string {
  const name = repoName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{3,}/g, "--")
    .slice(0, 100)
    .replace(/^[-._]+|[-._]+$/g, "");
  return name || "site";
}

/**
 * Vercel refused because its own GitHub app can't see the repository. Vercel documents no
 * dedicated code for this: it answers `bad_request` with "To link a GitHub repository, you need
 * to install the GitHub integration first", or says the repository "can't be found". Only those
 * sentences (or a code naming a missing repository or Git link) count, so an unrelated 400
 * keeps Vercel's own message.
 */
function cannotSeeRepo(result: VercelResult<unknown>): boolean {
  if (result.status !== 400 && result.status !== 404) return false;
  const { code = "", message = "" } = result.body.error ?? {};
  return (
    /^(repo_not_found|git_repository_not_found|missing_git_integration|github_app_not_installed)$/i.test(
      code,
    ) ||
    /install the GitHub integration|GitHub repository can(?:'|no)t be found|(?:can(?:'|no)t|could not|unable to) (?:find|access) (?:the )?(?:GitHub )?repository/i.test(
      message,
    )
  );
}

/** A suffix for a second try when the team already has a project with the repository's name. */
const nameWithSuffix = (base: string, siteId: string) =>
  projectName(`${base.slice(0, 90)}-${siteId.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`);

/**
 * Gives the client's site a project on the agency's Vercel team that builds its GitHub
 * repository, once. Owners and admins only. When the repository already has a commit, the
 * first production deployment is asked for straight away; later commits deploy on push.
 */
export async function ensureSiteDeployment(
  deps: PublishDeps,
  ctx: SessionContext,
  client: AuthorizedClient,
  input: { siteId: string },
): Promise<SiteRow> {
  assertAuthorizedClient(client);
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const row = await clientSiteRow(deps, client, input.siteId);
  if (row.hostProjectId) return row;
  if (!row.repoFullName) throw new ConnectError("Give the site a GitHub repository first.");
  const grant = await hostGrant(deps, organizationId);
  const repo = splitRepo(row.repoFullName);

  const create = (name: string) =>
    vercel<{ id?: string; name?: string; link?: { productionBranch?: string } }>(
      deps,
      grant,
      "POST",
      "/v11/projects",
      {
        body: {
          name,
          framework: "nextjs",
          gitRepository: { type: "github", repo: row.repoFullName },
        },
      },
    );
  const firstName = projectName(repo.name);
  let created = await create(firstName);
  if (created.status === 409) {
    // The team already has a project by that name: try once more with the site's id on it.
    const second = nameWithSuffix(firstName, row.id);
    created = await create(second);
    if (created.status === 409) {
      throw new ConnectError(
        `Your Vercel team already has projects named ${firstName} and ${second}. Rename or remove one on Vercel, then try again.`,
      );
    }
  }
  if (cannotSeeRepo(created)) {
    throw new ConnectError(
      `Vercel can't see ${row.repoFullName}. On GitHub, give Vercel's GitHub app access to that repository (or to all repositories), then try again.`,
    );
  }
  if (!created.ok || !created.body.id) {
    throw refused(created, "Vercel didn't create the project. Try again.");
  }
  const projectId = created.body.id;

  const [updated] = await deps.db
    .update(site)
    .set({ host: "vercel", hostProjectId: projectId })
    .where(and(eq(site.id, row.id), isNull(site.hostProjectId)))
    .returning();
  // A concurrent request gave the site its project first; that one stays.
  if (!updated) return clientSiteRow(deps, client, row.id);
  await audit(deps.db, ctx, client, "site.project.create", {
    siteId: row.id,
    projectId,
    repoFullName: row.repoFullName,
  });

  // An app-style site's project needs its database settings before its first build.
  await ensureSiteBackendEnv(deps, client, { siteId: row.id });

  if (row.status === "pushed") {
    // A project made after the first commit has nothing to build until the next push. A refusal
    // here leaves the project in place: the next save deploys it.
    await vercel(deps, grant, "POST", "/v13/deployments", {
      body: {
        name: created.body.name ?? firstName,
        project: projectId,
        target: "production",
        gitSource: {
          type: "github",
          org: repo.owner,
          repo: repo.name,
          ref: created.body.link?.productionBranch ?? "main",
        },
      },
    });
  }
  return updated;
}

export interface SiteDeployment {
  /** Vercel's state: QUEUED, INITIALIZING, BUILDING, READY, ERROR or CANCELED. */
  state: string;
  /**
   * The site's public production address (`https://…`): the project's production alias, never
   * the deployment's own URL, which Vercel's deployment protection hides by default. While a
   * new deployment builds, the address already live; null before the first one is ready.
   */
  url: string | null;
  createdAt: number | null;
}

type ProjectAlias = string | { domain?: string };

/** The project's production address: its `<name>.vercel.app` alias when it has one. */
function productionHost(project: {
  name?: string;
  targets?: { production?: { alias?: ProjectAlias[] | null } | null } | null;
  alias?: ProjectAlias[] | null;
}): string | null {
  const aliases = [...(project.targets?.production?.alias ?? []), ...(project.alias ?? [])]
    .map((a) => (typeof a === "string" ? a : a.domain))
    .filter((a): a is string => !!a);
  const own = project.name ? `${project.name}.vercel.app` : null;
  return (
    (own && aliases.includes(own) ? own : undefined) ??
    aliases.find((a) => a.endsWith(".vercel.app")) ??
    aliases[0] ??
    own
  );
}

/**
 * The site's latest production deployment on Vercel, for showing its live address. Keeps the
 * project's production address on the site once a deployment is ready, and marks the site
 * failed when the latest production build failed. Preview deployments change nothing. Anyone
 * who may work on the client may look.
 */
export async function latestDeployment(
  deps: SiteDeps,
  client: AuthorizedClient,
  siteId: string,
): Promise<SiteDeployment | null> {
  assertAuthorizedClient(client);
  const row = await clientSiteRow(deps, client, siteId);
  if (row.host !== "vercel" || !row.hostProjectId) return null;
  const grant = await hostGrant(deps, client.location.organizationId);
  const result = await vercel<{
    deployments?: {
      url?: string | null;
      state?: string;
      readyState?: string;
      created?: number;
      createdAt?: number;
      target?: string | null;
    }[];
  }>(deps, grant, "GET", "/v6/deployments", {
    query: { projectId: row.hostProjectId, limit: "1", target: "production" },
  });
  if (!result.ok) throw refused(result, "Vercel didn't show the site's deployments. Try again.");
  const latest = result.body.deployments?.[0];
  // Asked for production only; anything else (a preview) is not the live site.
  if (!latest || (latest.target != null && latest.target !== "production")) return null;
  const state = latest.readyState ?? latest.state ?? "QUEUED";
  const createdAt = latest.created ?? latest.createdAt ?? null;

  if (state === "READY") {
    const project = await vercel<Parameters<typeof productionHost>[0]>(
      deps,
      grant,
      "GET",
      `/v9/projects/${encodeURIComponent(row.hostProjectId)}`,
    );
    if (!project.ok) throw refused(project, "Vercel didn't show the site's project. Try again.");
    const host = productionHost(project.body);
    const url = host ? `https://${host}` : null;
    if (url && (row.deployUrl !== url || row.status !== "deployed")) {
      await deps.db
        .update(site)
        .set({ deployUrl: url, status: "deployed" })
        .where(eq(site.id, row.id));
    }
    return { state, url, createdAt };
  }
  if (state === "ERROR" && row.status !== "failed") {
    await deps.db.update(site).set({ status: "failed" }).where(eq(site.id, row.id));
  }
  return { state, url: row.deployUrl, createdAt };
}
