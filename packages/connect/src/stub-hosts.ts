import { createHash } from "node:crypto";

/**
 * `GITHUB_MODE=stub` and `VERCEL_MODE=stub`: a pretend GitHub account and Vercel team, so both
 * connect flows and publishing a site run without either account. They answer the calls Locus
 * makes, shaped as the live docs describe them.
 */

export const STUB_GITHUB_CODE = "stub-github-code";
export const STUB_GITHUB_INSTALLATION = { id: 424242, login: "stub-agency-org" };
export const STUB_VERCEL_CODE = "stub-vercel-code";
export const STUB_VERCEL_TEAM = { id: "team_stub", name: "Stub Agency" };
export const STUB_VERCEL_CONFIGURATION = "icfg_stub";
export const STUB_VERCEL_PROJECT = { id: "prj_stub", name: "stub-client-site" };
/** The stub app's JWT issuer. The stub checks a JWT's issuer, not its signature. */
export const STUB_GITHUB_APP_ID = "Iv23-stub-app";
/** An empty repository the stub installation can already see, for linking. */
export const STUB_GITHUB_EMPTY_REPO = `${STUB_GITHUB_INSTALLATION.login}/existing-site`;
/** The stub Vercel team can't see GitHub repositories whose name starts with this. */
export const STUB_VERCEL_NO_ACCESS_PREFIX = "no-vercel-access";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The stub GitHub, plus a look at a repository's files on its default branch. */
export type StubGithub = typeof fetch & {
  repoFiles(fullName: string): Record<string, string> | null;
};

export function createStubGithub(): StubGithub {
  const publishing = createStubGitRepos();
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/login/oauth/access_token" && init?.method === "POST") {
      const code = new URLSearchParams(String(init.body ?? "")).get("code");
      return code === STUB_GITHUB_CODE
        ? json({ access_token: "ghu_stub", token_type: "bearer", scope: "" })
        : json({ error: "bad_verification_code" });
    }
    if (url.pathname === "/user/installations") {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer ghu_stub") return json({ message: "Bad credentials" }, 401);
      return json({
        total_count: 1,
        installations: [
          {
            id: STUB_GITHUB_INSTALLATION.id,
            app_slug: "locus-ghl",
            account: { login: STUB_GITHUB_INSTALLATION.login, type: "Organization" },
          },
        ],
      });
    }
    return publishing.handle(url, init);
  }) as StubGithub;
  stub.repoFiles = publishing.repoFiles;
  return stub;
}

interface StubRepo {
  fullName: string;
  /** `refs/heads/<branch>` → commit sha. No entries: the repository is empty. */
  refs: Map<string, string>;
  blobs: Map<string, string>;
  trees: Map<string, Record<string, string>>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
}

type Body = Record<string, unknown>;

/**
 * The Git side of publishing: installation tokens, repositories, and the Git database and
 * contents APIs, kept in memory. As on GitHub, the Git database API answers 409 while a
 * repository is empty, and a branch only moves forward unless forced.
 */
function createStubGitRepos() {
  const repos = new Map<string, StubRepo>();
  const tokens = new Set<string>();
  const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
  const addRepo = (fullName: string) => {
    const repo: StubRepo = {
      fullName,
      refs: new Map(),
      blobs: new Map(),
      trees: new Map(),
      commits: new Map(),
    };
    repos.set(fullName.toLowerCase(), repo);
    return repo;
  };
  addRepo(STUB_GITHUB_EMPTY_REPO);
  const repoInfo = (r: StubRepo) => ({
    full_name: r.fullName,
    name: r.fullName.split("/")[1],
    private: true,
    default_branch: "main",
  });
  const filesAt = (r: StubRepo, commit: string | undefined) =>
    commit ? { ...r.trees.get(r.commits.get(commit)?.tree ?? "") } : {};
  const addCommit = (r: StubRepo, tree: string, parents: string[], message: string) => {
    const commit = hash([tree, parents, message]);
    r.commits.set(commit, { tree, parents, message });
    return commit;
  };

  function app(url: URL, method: string, auth: string, body: Body): Response | undefined {
    const found = url.pathname.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/);
    if (!found) return undefined;
    const [, payload] = auth.split(".");
    let iss: unknown;
    try {
      iss = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).iss;
    } catch {}
    if (iss !== STUB_GITHUB_APP_ID) {
      return json({ message: "A JSON web token could not be decoded" }, 401);
    }
    if (found[1] !== String(STUB_GITHUB_INSTALLATION.id))
      return json({ message: "Not Found" }, 404);
    if (!found[2]) {
      return json({
        id: STUB_GITHUB_INSTALLATION.id,
        account: { login: STUB_GITHUB_INSTALLATION.login, type: "Organization" },
      });
    }
    if (method !== "POST") return json({ message: "Not Found" }, 404);
    const token = `ghs_stub_${tokens.size + 1}`;
    tokens.add(token);
    return json(
      {
        token,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: body.permissions ?? {},
        repository_selection: body.repositories ? "selected" : "all",
      },
      201,
    );
  }

  function git(repo: StubRepo, rest: string, method: string, body: Body): Response {
    const notFound = json({ message: "Not Found" }, 404);
    const ref = rest.match(/^\/git\/refs?\/(heads\/.+)$/);
    if (ref) {
      const name = `refs/${ref[1]}`;
      const current = repo.refs.get(name);
      if (method === "GET") {
        return current ? json({ ref: name, object: { type: "commit", sha: current } }) : notFound;
      }
      if (method === "PATCH") {
        const next = String(body.sha);
        if (!current) return json({ message: "Reference does not exist" }, 422);
        if (!body.force && !repo.commits.get(next)?.parents.includes(current)) {
          return json({ message: "Update is not a fast forward" }, 422);
        }
        repo.refs.set(name, next);
        return json({ ref: name, object: { type: "commit", sha: next } });
      }
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(body.ref);
      if (repo.refs.has(name)) return json({ message: "Reference already exists" }, 422);
      repo.refs.set(name, String(body.sha));
      return json({ ref: name, object: { type: "commit", sha: body.sha } }, 201);
    }
    if (rest === "/git/blobs" && method === "POST") {
      const content =
        body.encoding === "base64"
          ? Buffer.from(String(body.content), "base64").toString("latin1")
          : String(body.content);
      const blob = hash(["blob", content]);
      repo.blobs.set(blob, content);
      return json({ sha: blob }, 201);
    }
    if (rest === "/git/trees" && method === "POST") {
      const files: Record<string, string> = {};
      for (const item of body.tree as { path: string; sha?: string; content?: string }[]) {
        const content = item.content ?? (item.sha ? repo.blobs.get(item.sha) : undefined);
        if (content === undefined) return json({ message: "Invalid tree info" }, 422);
        files[item.path] = content;
      }
      const tree = hash(["tree", files]);
      repo.trees.set(tree, files);
      return json({ sha: tree }, 201);
    }
    if (rest === "/git/commits" && method === "POST") {
      const tree = String(body.tree);
      if (!repo.trees.has(tree)) return json({ message: "Tree not found" }, 422);
      const commit = addCommit(repo, tree, (body.parents as string[]) ?? [], String(body.message));
      return json(
        { sha: commit, html_url: `https://github.com/${repo.fullName}/commit/${commit}` },
        201,
      );
    }
    return notFound;
  }

  function handle(url: URL, init: RequestInit | undefined): Response {
    const method = init?.method ?? "GET";
    const auth = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Body;
    const notFound = json({ message: "Not Found" }, 404);

    const asApp = app(url, method, auth, body);
    if (asApp) return asApp;
    if (!tokens.has(auth)) return json({ message: "Bad credentials" }, 401);

    if (url.pathname === "/installation/repositories") {
      const list = [...repos.values()].map(repoInfo);
      return json({ total_count: list.length, repositories: list });
    }
    const org = url.pathname.match(/^\/orgs\/([^/]+)\/repos$/);
    if (org && method === "POST") {
      const fullName = `${decodeURIComponent(org[1] ?? "")}/${String(body.name)}`;
      if (repos.has(fullName.toLowerCase())) {
        return json(
          {
            message: "Repository creation failed.",
            errors: [{ resource: "Repository", field: "name", message: "name already exists" }],
          },
          422,
        );
      }
      return json(repoInfo(addRepo(fullName)), 201);
    }

    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const name = match
      ? `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`
      : "";
    const repo = repos.get(name.toLowerCase());
    if (!repo) return notFound;
    const rest = match?.[3] ?? "";
    if (rest === "") return json(repoInfo(repo));

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents && method === "PUT") {
      const path = (contents[1] ?? "").split("/").map(decodeURIComponent).join("/");
      const branch = `refs/heads/${String(body.branch ?? "main")}`;
      const head = repo.refs.get(branch);
      const files = filesAt(repo, head);
      files[path] = Buffer.from(String(body.content), "base64").toString("utf8");
      const tree = hash(["tree", files]);
      repo.trees.set(tree, files);
      const commit = addCommit(repo, tree, head ? [head] : [], String(body.message));
      repo.refs.set(branch, commit);
      return json({ content: { path }, commit: { sha: commit } }, 201);
    }
    if (!rest.startsWith("/git/")) return notFound;
    if (repo.refs.size === 0) return json({ message: "Git Repository is empty." }, 409);
    return git(repo, rest, method, body);
  }

  /** Text files as they are; binary ones as latin1 strings, one character per byte. */
  function repoFiles(fullName: string): Record<string, string> | null {
    const repo = repos.get(fullName.toLowerCase());
    if (!repo) return null;
    return filesAt(repo, repo.refs.get("refs/heads/main"));
  }

  return { handle, repoFiles };
}

export function createStubVercel(): typeof fetch {
  /** Domains on the stub project, and whether each is verified. */
  const domains = new Map<string, boolean>();
  /** Where a domain added with `redirect` sends visitors. */
  const redirects = new Map<string, string>();
  const created = createStubVercelPublishing();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v2/oauth/access_token" && init?.method === "POST") {
      const code = new URLSearchParams(String(init.body ?? "")).get("code");
      if (code !== STUB_VERCEL_CODE) return json({ error: "invalid_grant" }, 400);
      return json({
        token_type: "Bearer",
        access_token: "vercel-stub-token",
        installation_id: STUB_VERCEL_CONFIGURATION,
        user_id: "user_stub",
        team_id: STUB_VERCEL_TEAM.id,
      });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer vercel-stub-token") return json({ error: { code: "forbidden" } }, 403);
    if (url.pathname === `/v2/teams/${STUB_VERCEL_TEAM.id}`) {
      return json({ id: STUB_VERCEL_TEAM.id, slug: "stub-agency", name: STUB_VERCEL_TEAM.name });
    }
    return (
      created.handle(url, init?.method ?? "GET", init?.body) ??
      stubVercelProjects(url, init?.method ?? "GET", init?.body, domains, redirects)
    );
  }) as typeof fetch;
}

/**
 * Projects made for published sites, and their deployments. Every project reports one ready
 * production deployment at `<name>.vercel.app`, as if its first push had built. A repository
 * whose name starts with `no-vercel-access` is one Vercel's GitHub app can't see.
 */
function createStubVercelPublishing() {
  const projects = new Map<string, { id: string; name: string; repo: string }>();
  const deployments: { uid: string; projectId: string }[] = [];

  function handle(
    url: URL,
    method: string,
    raw: BodyInit | null | undefined,
  ): Response | undefined {
    const body = (raw ? JSON.parse(String(raw)) : {}) as {
      name?: string;
      project?: string;
      gitRepository?: { type?: string; repo?: string };
    };
    if (url.pathname === "/v11/projects" && method === "POST") {
      const repo = body.gitRepository?.repo ?? "";
      if ((repo.split("/")[1] ?? "").startsWith(STUB_VERCEL_NO_ACCESS_PREFIX)) {
        return json(
          {
            error: {
              code: "bad_request",
              message:
                "To link a GitHub repository, you need to install the GitHub integration first.",
            },
          },
          400,
        );
      }
      const name = body.name ?? "";
      if ([...projects.values()].some((p) => p.name === name)) {
        return json({ error: { code: "conflict", message: "Project already exists" } }, 409);
      }
      const project = { id: `prj_stub_${projects.size + 1}`, name, repo };
      projects.set(project.id, project);
      return json({
        id: project.id,
        name,
        framework: "nextjs",
        link: { type: "github", repo, productionBranch: "main" },
      });
    }
    if (url.pathname === "/v13/deployments" && method === "POST") {
      const project = projects.get(body.project ?? "");
      if (!project)
        return json({ error: { code: "not_found", message: "Project not found" } }, 404);
      const uid = `dpl_stub_${deployments.length + 1}`;
      deployments.push({ uid, projectId: project.id });
      return json({ id: uid, readyState: "QUEUED", url: `${project.name}-${uid}.vercel.app` });
    }
    const got = url.pathname.match(/^\/v9\/projects\/([^/]+)$/);
    const own = got ? projects.get(decodeURIComponent(got[1] ?? "")) : undefined;
    if (own && method === "GET") {
      const alias = [`${own.name}.vercel.app`, `${own.name}-stub-agency.vercel.app`];
      return json({
        id: own.id,
        name: own.name,
        framework: "nextjs",
        targets: { production: { alias } },
      });
    }
    if (url.pathname === "/v6/deployments" && method === "GET") {
      const target = url.searchParams.get("target");
      if (target && target !== "production") {
        return json({ deployments: [], pagination: { count: 0, next: null } });
      }
      const projectId = url.searchParams.get("projectId") ?? "";
      const project =
        projects.get(projectId) ??
        (projectId === STUB_VERCEL_PROJECT.id ? { ...STUB_VERCEL_PROJECT, repo: "" } : undefined);
      if (!project) return json({ deployments: [], pagination: { count: 0, next: null } });
      return json({
        deployments: [
          {
            uid: `dpl_${project.id}`,
            name: project.name,
            projectId: project.id,
            url: `${project.name}-a1b2c3d4e-stub-agency.vercel.app`,
            state: "READY",
            readyState: "READY",
            target: "production",
            created: Date.now(),
          },
        ],
        pagination: { count: 1, next: null },
      });
    }
    return undefined;
  }

  return { handle };
}

/**
 * The stub team's one project and its domains. A domain is verified once its check runs, and
 * points at Vercel unless its name starts with `pending.`, so both DNS steps can be seen.
 */
function stubVercelProjects(
  url: URL,
  method: string,
  body: BodyInit | null | undefined,
  domains: Map<string, boolean>,
  redirects: Map<string, string>,
): Response {
  const notFound = json({ error: { code: "not_found", message: "Not found" } }, 404);
  if (url.pathname === "/v10/projects" && method === "GET") {
    return json({ projects: [STUB_VERCEL_PROJECT], pagination: { count: 1, next: null } });
  }
  const config = url.pathname.match(/^\/v6\/domains\/([^/]+)\/config$/);
  if (config) {
    const domain = decodeURIComponent(config[1] ?? "");
    return json({
      configuredBy: domain.startsWith("pending.") ? null : "CNAME",
      misconfigured: domain.startsWith("pending."),
      acceptedChallenges: ["http-01"],
      recommendedCNAME: [{ rank: 1, value: "stub.vercel-dns-017.com." }],
      recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
    });
  }
  const match = url.pathname.match(
    /^\/v(?:9|10)\/projects\/([^/]+)(?:\/domains(?:\/([^/]+))?(\/verify)?)?$/,
  );
  if (!match || decodeURIComponent(match[1] ?? "") !== STUB_VERCEL_PROJECT.id) return notFound;
  const [, , rawDomain, verify] = match;
  if (!url.pathname.includes("/domains")) return json(STUB_VERCEL_PROJECT);

  const shape = (name: string) => {
    const apexName = name.split(".").slice(-2).join(".");
    const verified = domains.get(name) ?? false;
    return {
      name,
      apexName,
      projectId: STUB_VERCEL_PROJECT.id,
      redirect: redirects.get(name) ?? null,
      verified,
      ...(verified
        ? {}
        : {
            verification: [
              {
                type: "TXT",
                domain: `_vercel.${apexName}`,
                value: `vc-domain-verify=${name},stub`,
                reason: "pending_domain_verification",
              },
            ],
          }),
    };
  };
  if (!rawDomain && method === "POST") {
    const { name, redirect } = JSON.parse(String(body ?? "{}")) as {
      name: string;
      redirect?: string;
    };
    domains.set(name, false);
    if (redirect) redirects.set(name, redirect);
    return json(shape(name));
  }
  const domain = decodeURIComponent(rawDomain ?? "");
  if (!domains.has(domain)) return notFound;
  if (verify && method === "POST") {
    domains.set(domain, true);
    return json(shape(domain));
  }
  if (method === "DELETE") {
    domains.delete(domain);
    redirects.delete(domain);
    return json({});
  }
  return json(shape(domain));
}
