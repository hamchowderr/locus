import { LocalProvisioner, type TenantProvisioner, tenantDbName } from "./provisioner.ts";

export interface TursoConfig {
  /** The organisation slug, e.g. `hamchowderr`. */
  org: string;
  /** The group every client database is created in. It must already exist. */
  group: string;
  /** A Platform API token: `db:create`, `db:delete`, `db:mint-token` on that group. */
  apiToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** A Turso Platform API failure. Carries the status and Turso's message, never a token. */
export class TursoError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TursoError";
    this.status = status;
  }
}

// Turso's own duration format, e.g. "10m", "1h", "2w1d30m". Tokens always expire: the only
// way to revoke one is to rotate the database's keys, so a short life is the revocation.
const TTL = /^(\d+[wdhm])+$/;
const DB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOSTNAME = /^[a-z0-9.-]+\.turso\.io$/;

/**
 * Production's provisioner: one Turso database per client, through the Platform API
 * (docs.turso.tech/api-reference, read 2026-10-10).
 *
 * New databases start empty; `provisionLocation` applies every tenant migration straight away,
 * so they are on the current schema from the start without a template to keep in step.
 * The hostname is always the one Turso returns: it includes the region and is never built here.
 */
export class TursoProvisioner implements TenantProvisioner {
  private readonly config: Required<Omit<TursoConfig, "fetch">> & { fetch: typeof fetch };

  constructor(config: TursoConfig) {
    for (const key of ["org", "group", "apiToken"] as const) {
      if (!config[key]) throw new Error(`Turso ${key} is required`);
    }
    this.config = {
      ...config,
      fetch: config.fetch ?? fetch,
      baseUrl: config.baseUrl ?? "https://api.turso.tech",
    };
  }

  async create(locationId: string) {
    const name = tenantDbName(locationId);
    const body = await this.call<{ database?: { Name?: string; Hostname?: string } }>(
      "POST",
      "/databases",
      { name, group: this.config.group },
    );
    const hostname = body.database?.Hostname;
    if (!hostname || !HOSTNAME.test(hostname)) {
      throw new TursoError(502, `Turso created ${name} but returned no usable hostname`);
    }
    return { dbName: body.database?.Name ?? name, hostname };
  }

  async mintToken(dbName: string, opts: { readOnly?: boolean; ttl: string }) {
    if (!TTL.test(opts.ttl)) throw new Error(`Token lifetime must look like "10m" or "1h"`);
    const query = new URLSearchParams({
      expiration: opts.ttl,
      authorization: opts.readOnly ? "read-only" : "full-access",
    });
    const body = await this.call<{ jwt?: string }>(
      "POST",
      `/databases/${checkName(dbName)}/auth/tokens?${query}`,
    );
    if (!body.jwt) throw new TursoError(502, `Turso minted no token for ${dbName}`);
    return body.jwt;
  }

  /**
   * Proves the token, organisation and group work together by reading the group: a wrong token
   * answers 401, a wrong organisation or group 404. Throws that `TursoError`.
   */
  async check(signal?: AbortSignal) {
    await this.call("GET", `/groups/${encodeURIComponent(this.config.group)}`, undefined, signal);
  }

  /** Safe to repeat: a database that is already gone counts as deleted. */
  async destroy(dbName: string) {
    try {
      await this.call("DELETE", `/databases/${checkName(dbName)}`);
    } catch (error) {
      if (error instanceof TursoError && error.status === 404) return;
      throw error;
    }
  }

  url(hostname: string) {
    if (!HOSTNAME.test(hostname)) throw new Error(`Not a Turso hostname: ${hostname}`);
    return `libsql://${hostname}`;
  }

  private async call<T>(
    method: string,
    path: string,
    json?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const { baseUrl, org, apiToken } = this.config;
    const headers: Record<string, string> = { authorization: `Bearer ${apiToken}` };
    if (json !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (json !== undefined) init.body = JSON.stringify(json);
    if (signal) init.signal = signal;
    const response = await this.config.fetch(
      `${baseUrl}/v1/organizations/${encodeURIComponent(org)}${path}`,
      init,
    );
    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const message =
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      throw new TursoError(response.status, `Turso ${method} ${path.split("?")[0]}: ${message}`);
    }
    return body as T;
  }
}

function checkName(dbName: string) {
  if (!DB_NAME.test(dbName)) throw new Error(`Invalid database name: ${dbName}`);
  return dbName;
}

/**
 * `LOCUS_PROVISIONER=local` (the default outside production) or `turso` (the default, and the
 * only choice, in production) with `TURSO_ORG`, `TURSO_GROUP` and `TURSO_API_TOKEN`.
 */
export function provisionerFromEnv(
  localDir: string,
  env: Record<string, string | undefined> = process.env,
): TenantProvisioner {
  const production = env.NODE_ENV === "production";
  const mode = env.LOCUS_PROVISIONER ?? (production ? "turso" : "local");
  if (mode === "local") {
    if (production) throw new Error("LOCUS_PROVISIONER=local isolates nothing; not in production");
    return new LocalProvisioner(localDir);
  }
  if (mode === "turso") {
    const missing = ["TURSO_ORG", "TURSO_GROUP", "TURSO_API_TOKEN"].filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`${missing.join(", ")} not set`);
    return new TursoProvisioner({
      org: env.TURSO_ORG as string,
      group: env.TURSO_GROUP as string,
      apiToken: env.TURSO_API_TOKEN as string,
    });
  }
  throw new Error(`LOCUS_PROVISIONER must be "local" or "turso" (got ${mode})`);
}
