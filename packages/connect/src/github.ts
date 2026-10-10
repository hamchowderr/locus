import { createHmac, timingSafeEqual } from "node:crypto";
import { requireAgencyManager, type SessionContext } from "@locus/auth";
import type { ControlDb } from "@locus/db";
import { githubInstallation } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { ConnectError } from "./agency.ts";

// Contracts read from docs.github.com on 2026-10-10: installing an app, generating a user
// access token, `GET /user/installations`, and validating webhook deliveries.

/** The Locus GitHub App (`locus-ghl`), registered with "request user authorization on install". */
export interface GithubAppConfig {
  slug: string;
  clientId: string;
  clientSecret: string;
}

export interface GithubHttp {
  fetch?: typeof fetch;
  /** `https://github.com`, where the OAuth code is exchanged. */
  webBaseUrl?: string;
  /** `https://api.github.com`. */
  apiBaseUrl?: string;
}

export interface GithubConnectDeps {
  db: ControlDb;
  github: GithubAppConfig;
  http?: GithubHttp;
  now?: () => number;
}

const API_VERSION = "2026-03-10";

/** Where an owner or admin installs the app. GitHub hands `state` back to the callback. */
export function githubInstallUrl(config: GithubAppConfig, state: string): string {
  const url = new URL(
    `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.toString();
}

interface UserInstallation {
  id: number;
  app_slug?: string;
  account?: { login?: string; type?: string } | null;
}

/**
 * Links the session's agency to a GitHub App installation after the install redirect.
 *
 * GitHub warns that the callback's `installation_id` can be forged, so it is never trusted:
 * the `code` is exchanged for the installing user's token, and the installation must be one
 * that user can access (`GET /user/installations`). The user token is used for that check
 * only and then dropped; Locus acts later as the app itself, with installation tokens.
 */
export async function connectGithub(
  deps: GithubConnectDeps,
  ctx: SessionContext,
  input: { code: string; installationId?: string | null },
): Promise<{ installationId: string; accountLogin: string }> {
  const { organizationId } = await requireAgencyManager(deps.db, ctx);
  const userToken = await exchangeGithubCode(deps, input.code);
  const installations = (await listUserInstallations(deps, userToken)).filter(
    (i) => !i.app_slug || i.app_slug === deps.github.slug,
  );

  let chosen: UserInstallation | undefined;
  if (input.installationId) {
    chosen = installations.find((i) => String(i.id) === input.installationId);
    if (!chosen) {
      throw new ConnectError("That GitHub installation isn't one your GitHub account can access.");
    }
  } else if (installations.length === 1) {
    chosen = installations[0];
  } else {
    throw new ConnectError(
      installations.length === 0
        ? "Locus isn't installed on any GitHub account you can access."
        : "Locus is installed on several GitHub accounts. Install it again from Locus to pick one.",
    );
  }
  const installationId = String(chosen?.id);
  const accountLogin = chosen?.account?.login;
  if (!accountLogin)
    throw new ConnectError("GitHub didn't say which account Locus is installed on.");

  const values = {
    installationId,
    orgLogin: accountLogin,
    connectedAt: new Date(deps.now?.() ?? Date.now()),
  };
  await deps.db
    .insert(githubInstallation)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: githubInstallation.organizationId, set: values });
  return { installationId, accountLogin };
}

async function exchangeGithubCode(deps: GithubConnectDeps, code: string): Promise<string> {
  const { fetch: f = fetch, webBaseUrl = "https://github.com" } = deps.http ?? {};
  const response = await f(`${webBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.github.clientId,
      client_secret: deps.github.clientSecret,
      code,
    }).toString(),
  });
  // GitHub answers 200 with an `error` field for a bad or used code.
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new ConnectError("GitHub didn't accept that sign-in. Try connecting again.");
  }
  return body.access_token;
}

async function listUserInstallations(
  deps: GithubConnectDeps,
  userToken: string,
): Promise<UserInstallation[]> {
  const { fetch: f = fetch, apiBaseUrl = "https://api.github.com" } = deps.http ?? {};
  const all: UserInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await f(`${apiBaseUrl}/user/installations?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userToken}`,
        "x-github-api-version": API_VERSION,
      },
    });
    if (!response.ok) throw new ConnectError("GitHub didn't list your installations. Try again.");
    const body = (await response.json()) as {
      total_count?: number;
      installations?: UserInstallation[];
    };
    const batch = body.installations ?? [];
    all.push(...batch);
    if (batch.length < 100 || all.length >= (body.total_count ?? 0)) break;
  }
  return all;
}

/** `X-Hub-Signature-256`: `sha256=` + the hex HMAC-SHA256 of the raw body. */
export function verifyGithubSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`,
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface GithubWebhook {
  action?: string;
  installation?: { id?: number | string };
}

/**
 * The `installation` event. When the app is uninstalled, every agency linked to that
 * installation loses the link; other actions change nothing yet.
 */
export async function handleGithubWebhook(
  deps: Pick<GithubConnectDeps, "db">,
  event: string | null,
  payload: GithubWebhook,
): Promise<"unlinked" | "ignored"> {
  const id = payload.installation?.id;
  if (event !== "installation" || payload.action !== "deleted" || id === undefined) {
    return "ignored";
  }
  await deps.db.delete(githubInstallation).where(eq(githubInstallation.installationId, String(id)));
  return "unlinked";
}
