import {
  createStubGithub,
  createStubVercel,
  type GithubConnectDeps,
  type SiteDeps,
  STUB_GITHUB_CODE,
  STUB_GITHUB_INSTALLATION,
  STUB_VERCEL_CODE,
  STUB_VERCEL_CONFIGURATION,
  STUB_VERCEL_TEAM,
  type VercelConnectDeps,
} from "@locus/connect";
import { baseUrl, required, secretStore, serviceMode } from "./connect.ts";
import { locus } from "./locus.ts";

export const GITHUB_STATE_COOKIE = "locus_github_state";
export const VERCEL_STATE_COOKIE = "locus_vercel_state";

let stubGithub: typeof fetch | undefined;
let stubVercel: typeof fetch | undefined;

/** `GITHUB_MODE=stub` plays a pretend GitHub account with Locus installed on one org. */
export function githubDeps(): GithubConnectDeps {
  const { db } = locus();
  if (serviceMode("GITHUB_MODE") === "stub") {
    stubGithub ??= createStubGithub();
    return {
      db,
      github: { slug: "locus-ghl", clientId: "stub-client", clientSecret: "stub-secret" },
      http: {
        fetch: stubGithub,
        webBaseUrl: "https://github.stub",
        apiBaseUrl: "https://api.github.stub",
      },
    };
  }
  return {
    db,
    github: {
      slug: required("GITHUB_APP_SLUG"),
      clientId: required("GITHUB_APP_CLIENT_ID"),
      clientSecret: required("GITHUB_APP_CLIENT_SECRET"),
    },
  };
}

/** `VERCEL_MODE=stub` plays a pretend Vercel team. */
export function vercelDeps(): VercelConnectDeps {
  const { db } = locus();
  const redirectUri = `${baseUrl()}/api/connect/vercel/callback`;
  if (serviceMode("VERCEL_MODE") === "stub") {
    stubVercel ??= createStubVercel();
    return {
      db,
      secrets: secretStore(db),
      vercel: {
        slug: "locus-otaku",
        clientId: "stub-client",
        clientSecret: "stub-secret",
        redirectUri,
      },
      http: { fetch: stubVercel, apiBaseUrl: "https://api.vercel.stub" },
    };
  }
  return {
    db,
    secrets: secretStore(db),
    vercel: {
      slug: required("VERCEL_INTEGRATION_SLUG"),
      clientId: required("VERCEL_INTEGRATION_CLIENT_ID"),
      clientSecret: required("VERCEL_INTEGRATION_CLIENT_SECRET"),
      redirectUri,
    },
  };
}

/** For a client's site and its domain, on the agency's connected Vercel team. */
export function siteDeps(): SiteDeps {
  const { db, secrets, http } = vercelDeps();
  return { db, secrets, ...(http ? { http } : {}) };
}

/** In stub mode the "install" pages are local routes that approve straight away. */
export function stubGithubCallback(state: string): string {
  const callback = new URL("/api/connect/github/callback", baseUrl());
  callback.searchParams.set("code", STUB_GITHUB_CODE);
  callback.searchParams.set("installation_id", String(STUB_GITHUB_INSTALLATION.id));
  callback.searchParams.set("setup_action", "install");
  callback.searchParams.set("state", state);
  return callback.toString();
}

export function stubVercelCallback(state: string): string {
  const callback = new URL("/api/connect/vercel/callback", baseUrl());
  callback.searchParams.set("code", STUB_VERCEL_CODE);
  callback.searchParams.set("configurationId", STUB_VERCEL_CONFIGURATION);
  callback.searchParams.set("teamId", STUB_VERCEL_TEAM.id);
  callback.searchParams.set("source", "external");
  callback.searchParams.set("state", state);
  return callback.toString();
}
