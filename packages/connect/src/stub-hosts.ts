/**
 * `GITHUB_MODE=stub` and `VERCEL_MODE=stub`: a pretend GitHub account and Vercel team, so both
 * connect flows run without either account. They answer the calls Locus makes, shaped as the
 * live docs describe them.
 */

export const STUB_GITHUB_CODE = "stub-github-code";
export const STUB_GITHUB_INSTALLATION = { id: 424242, login: "stub-agency-org" };
export const STUB_VERCEL_CODE = "stub-vercel-code";
export const STUB_VERCEL_TEAM = { id: "team_stub", name: "Stub Agency" };
export const STUB_VERCEL_CONFIGURATION = "icfg_stub";
export const STUB_VERCEL_PROJECT = { id: "prj_stub", name: "stub-client-site" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createStubGithub(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
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
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

export function createStubVercel(): typeof fetch {
  /** Domains on the stub project, and whether each is verified. */
  const domains = new Map<string, boolean>();
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
    return stubVercelProjects(url, init?.method ?? "GET", init?.body, domains);
  }) as typeof fetch;
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
    const { name } = JSON.parse(String(body ?? "{}")) as { name: string };
    domains.set(name, false);
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
    return json({});
  }
  return json(shape(domain));
}
