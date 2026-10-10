import { type ConnectDeps, createStubGhl, type GhlAppConfig, STUB_CODE } from "@locus/connect";
import { DbSecretStore, provisionerFromEnv } from "@locus/db";
import { secretsFromEnv } from "@locus/secrets";
import { locus, NotConfigured } from "./locus.ts";

const production = process.env.NODE_ENV === "production";

/** `GHL_MODE=stub` (the default outside production) plays a pretend agency; `live` is GHL. */
export function ghlMode(): "stub" | "live" {
  const mode = process.env.GHL_MODE ?? (production ? "live" : "stub");
  if (mode === "stub" && production) throw new NotConfigured("GHL_MODE=stub in production");
  if (mode !== "stub" && mode !== "live") throw new NotConfigured(`GHL_MODE=${mode}`);
  return mode;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new NotConfigured(`${name} is not set`);
  return value;
}

export function baseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function appConfig(): GhlAppConfig {
  const redirectUri = `${baseUrl()}/api/connect/crm/callback`;
  if (ghlMode() === "stub") {
    return {
      clientId: "stub-client",
      clientSecret: "stub-secret",
      appId: "stub-app",
      redirectUri,
      scopes: ["locations.readonly", "oauth.readonly", "oauth.write"],
    };
  }
  return {
    clientId: required("GHL_CLIENT_ID"),
    clientSecret: required("GHL_CLIENT_SECRET"),
    appId: required("GHL_APP_ID"),
    redirectUri,
    scopes: required("GHL_SCOPES").split(/\s+/).filter(Boolean),
  };
}

let stubFetch: typeof fetch | undefined;

/** Building these fails only on configuration (a mode, a missing key or token): a 503. */
function configured<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new NotConfigured((error as Error).message);
  }
}

/** Everything the connect flow needs, from the environment. Server-side only. */
export function connectDeps(): ConnectDeps {
  const mode = ghlMode();
  stubFetch ??= createStubGhl();
  const { db } = locus();
  return {
    db,
    secrets: configured(() =>
      secretsFromEnv({
        localFile: ".data/secrets.json",
        encrypted: (cipher) => new DbSecretStore(db, cipher),
      }),
    ),
    provisioner: configured(() => provisionerFromEnv(".data/tenants")),
    ghl: appConfig(),
    ...(mode === "stub" ? { http: { fetch: stubFetch, baseUrl: "https://stub.ghl.local" } } : {}),
  };
}

/** In stub mode the "GHL approval page" is a local route that approves straight away. */
export function stubAuthorizeTarget(state: string): string {
  const callback = new URL("/api/connect/crm/callback", baseUrl());
  callback.searchParams.set("code", STUB_CODE);
  callback.searchParams.set("state", state);
  return callback.toString();
}

export const STATE_COOKIE = "locus_crm_state";

// GHL refuses redirect and webhook URLs that mention HighLevel ("The redirect url contains a
// Highlevel reference"), so the routes that GHL calls are named `crm`, never `ghl`.
