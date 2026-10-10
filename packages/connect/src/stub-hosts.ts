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
    if (url.pathname === `/v2/teams/${STUB_VERCEL_TEAM.id}`) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer vercel-stub-token") return json({ error: { code: "forbidden" } }, 403);
      return json({ id: STUB_VERCEL_TEAM.id, slug: "stub-agency", name: STUB_VERCEL_TEAM.name });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
}
