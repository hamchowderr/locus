import { describe, expect, it } from "vitest";
import { InfisicalLoadError, loadInfisicalEnv } from "./infisical.ts";

const identity = {
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret-value",
  INFISICAL_PROJECT_ID: "project-1",
};

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeInfisical(
  listing: { status?: number; json?: unknown } = {
    json: {
      secrets: [
        { secretKey: "TURSO_ORG", secretValue: "hamchowderr" },
        { secretKey: "LOCUS_SECRETS_KEY", secretValue: "sealing-key" },
      ],
      imports: [
        {
          secretPath: "/shared",
          secrets: [
            { secretKey: "SHARED_ONLY", secretValue: "from-shared" },
            { secretKey: "TURSO_ORG", secretValue: "shared-must-not-win" },
            { secretKey: "INFISICAL_PROJECT_ID", secretValue: "must-not-overwrite" },
          ],
        },
      ],
    },
  },
  login: { status?: number; json?: unknown } = { json: { accessToken: "access-token-1" } },
) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const reply = call.url.pathname.endsWith("/universal-auth/login") ? login : listing;
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("loading settings from Infisical", () => {
  it("logs in with the machine identity and reads /locus in prod, with imports", async () => {
    const { calls, fetch } = fakeInfisical();
    const env: Record<string, string | undefined> = { ...identity };
    await loadInfisicalEnv(env, { fetch });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.href).toBe("https://app.infisical.com/api/v1/auth/universal-auth/login");
    expect(calls[0]?.body).toEqual({ clientId: "client-id", clientSecret: "client-secret-value" });

    expect(calls[1]?.url.pathname).toBe("/api/v4/secrets");
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      projectId: "project-1",
      environment: "prod",
      secretPath: "/locus",
      includeImports: "true",
      expandSecretReferences: "true",
      recursive: "false",
      viewSecretValue: "true",
    });
    expect(calls[1]?.headers.authorization).toBe("Bearer access-token-1");
  });

  it("sets each value once: the folder over its imports, the environment over both", async () => {
    const { fetch } = fakeInfisical();
    const env: Record<string, string | undefined> = {
      ...identity,
      LOCUS_SECRETS_KEY: "already-set",
    };
    const result = await loadInfisicalEnv(env, { fetch });

    expect(env.TURSO_ORG).toBe("hamchowderr");
    expect(env.SHARED_ONLY).toBe("from-shared");
    expect(env.LOCUS_SECRETS_KEY).toBe("already-set");
    expect(env.INFISICAL_PROJECT_ID).toBe("project-1");
    expect(result).toEqual({ loaded: ["TURSO_ORG", "SHARED_ONLY"], kept: ["LOCUS_SECRETS_KEY"] });
    expect(JSON.stringify(result)).not.toContain("hamchowderr");
  });

  it("honours the environment, path and site settings", async () => {
    const { calls, fetch } = fakeInfisical();
    await loadInfisicalEnv(
      {
        ...identity,
        INFISICAL_ENVIRONMENT: "staging",
        INFISICAL_SECRET_PATH: "/locus-preview",
        INFISICAL_SITE_URL: "https://us.infisical.com/",
      },
      { fetch },
    );
    expect(calls[0]?.url.origin).toBe("https://us.infisical.com");
    expect(calls[1]?.url.searchParams.get("environment")).toBe("staging");
    expect(calls[1]?.url.searchParams.get("secretPath")).toBe("/locus-preview");
  });

  it("refuses to start without an identity, and says only which setting is missing", async () => {
    await expect(loadInfisicalEnv({ INFISICAL_PROJECT_ID: "p" })).rejects.toThrow(
      "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET not set",
    );
  });

  it("fails clearly on a refused login or folder, without credentials in the error", async () => {
    const badLogin = fakeInfisical(undefined, { status: 401, json: { message: "nope" } });
    const loginError = await loadInfisicalEnv({ ...identity }, { fetch: badLogin.fetch }).catch(
      (e: unknown) => e,
    );
    expect(loginError).toBeInstanceOf(InfisicalLoadError);
    expect(String(loginError)).toContain("HTTP 401");
    expect(String(loginError)).not.toContain("client-secret-value");

    const badFolder = fakeInfisical({ status: 403, json: { message: "no access" } });
    await expect(loadInfisicalEnv({ ...identity }, { fetch: badFolder.fetch })).rejects.toThrow(
      "Infisical refused prod:/locus (HTTP 403)",
    );
  });
});
