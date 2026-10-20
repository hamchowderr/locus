import { describe, expect, it } from "vitest";
import { LocalProvisioner } from "./provisioner.ts";
import { provisionerFromEnv, TursoError, TursoProvisioner } from "./turso.ts";

const API_TOKEN = "platform-token-never-leaks";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeTurso(respond: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status = 200, json = {} } = respond(call);
    return new Response(JSON.stringify(json), { status });
  }) as typeof globalThis.fetch;
  const provisioner = new TursoProvisioner({
    org: "hamchowderr",
    group: "locus",
    apiToken: API_TOKEN,
    fetch,
    baseUrl: "https://turso.test",
  });
  return { calls, provisioner };
}

describe("TursoProvisioner", () => {
  it("creates the database in the group and keeps the hostname Turso returns", async () => {
    const hostname = "loc-abc-hamchowderr.aws-us-east-1.turso.io";
    const { calls, provisioner } = fakeTurso(() => ({
      json: { database: { DbId: "x", Name: "loc-abc", Hostname: hostname } },
    }));
    expect(await provisioner.create("ABC")).toEqual({ dbName: "loc-abc", hostname });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/organizations/hamchowderr/databases");
    expect(calls[0]?.body).toEqual({ name: "loc-abc", group: "locus" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(provisioner.url(hostname)).toBe(`libsql://${hostname}`);
  });

  it("refuses a create that comes back without a Turso hostname", async () => {
    const { provisioner } = fakeTurso(() => ({ json: { database: { Name: "loc-abc" } } }));
    await expect(provisioner.create("abc")).rejects.toThrow(/no usable hostname/);
    const { provisioner: odd } = fakeTurso(() => ({
      json: { database: { Name: "loc-abc", Hostname: "evil.example.com" } },
    }));
    await expect(odd.create("abc")).rejects.toThrow(/no usable hostname/);
  });

  it("mints a token for one database that always expires", async () => {
    const { calls, provisioner } = fakeTurso(() => ({ json: { jwt: "db-jwt" } }));
    expect(await provisioner.mintToken("loc-abc", { ttl: "10m" })).toBe("db-jwt");
    expect(calls[0]?.url.pathname).toBe(
      "/v1/organizations/hamchowderr/databases/loc-abc/auth/tokens",
    );
    expect(calls[0]?.url.searchParams.get("expiration")).toBe("10m");
    expect(calls[0]?.url.searchParams.get("authorization")).toBe("full-access");

    await provisioner.mintToken("loc-abc", { ttl: "1h", readOnly: true });
    expect(calls[1]?.url.searchParams.get("authorization")).toBe("read-only");

    // A published site's own token: reset by rotating its database's keys.
    await provisioner.mintToken("site-abc", { ttl: "never" });
    expect(calls[2]?.url.searchParams.get("expiration")).toBe("never");

    for (const ttl of ["", "forever", "Never", "10", "10s"]) {
      await expect(provisioner.mintToken("loc-abc", { ttl })).rejects.toThrow(/lifetime/);
    }
    await expect(provisioner.mintToken("../other", { ttl: "10m" })).rejects.toThrow(/name/);
    expect(calls).toHaveLength(3);
  });

  it("deletes, and treats a database that is already gone as deleted", async () => {
    let status = 200;
    const { calls, provisioner } = fakeTurso(() => ({
      status,
      json: { error: "record not found" },
    }));
    await provisioner.destroy("loc-abc");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/v1/organizations/hamchowderr/databases/loc-abc");
    status = 404;
    await expect(provisioner.destroy("loc-abc")).resolves.toBeUndefined();
    status = 500;
    await expect(provisioner.destroy("loc-abc")).rejects.toBeInstanceOf(TursoError);
  });

  it("checks its settings by reading its group", async () => {
    let status = 200;
    const { calls, provisioner } = fakeTurso(() => ({
      status,
      json: status === 200 ? { group: { name: "locus" } } : { error: "refused" },
    }));
    await provisioner.check();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/v1/organizations/hamchowderr/groups/locus");
    for (const refused of [401, 404]) {
      status = refused;
      const error = await provisioner.check().catch((e: unknown) => e);
      expect((error as TursoError).status).toBe(refused);
      expect(String(error)).not.toContain(API_TOKEN);
    }
  });

  it("creates a site database by name, empty or forked from another at a moment", async () => {
    const hostname = "site-1-hamchowderr.aws-us-east-1.turso.io";
    const { calls, provisioner } = fakeTurso(() => ({
      json: { database: { Name: "site-1", Hostname: hostname } },
    }));
    expect(await provisioner.createDatabase("site-1")).toEqual({ dbName: "site-1", hostname });
    expect(calls[0]?.body).toEqual({ name: "site-1", group: "locus" });

    await provisioner.createDatabase("site-1-copy", {
      fork: { from: "site-1", at: new Date("2026-10-20T05:00:00.123Z") },
    });
    expect(calls[1]?.body).toEqual({
      name: "site-1-copy",
      group: "locus",
      seed: { type: "database", name: "site-1", timestamp: "2026-10-20T05:00:00Z" },
    });
    await provisioner.createDatabase("site-1-now", { fork: { from: "site-1" } });
    expect(calls[2]?.body).toEqual({
      name: "site-1-now",
      group: "locus",
      seed: { type: "database", name: "site-1" },
    });

    await expect(provisioner.createDatabase("Bad Name")).rejects.toThrow(/name/);
    await expect(provisioner.createDatabase("ok", { fork: { from: "../other" } })).rejects.toThrow(
      /name/,
    );
    expect(calls).toHaveLength(3);
  });

  it("finds a database by name, or reports none", async () => {
    const hostname = "site-1-hamchowderr.aws-us-east-1.turso.io";
    let status = 200;
    const { calls, provisioner } = fakeTurso(() => ({
      status,
      json: status === 200 ? { database: { Name: "site-1", Hostname: hostname } } : {},
    }));
    expect(await provisioner.findDatabase("site-1")).toEqual({ dbName: "site-1", hostname });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/v1/organizations/hamchowderr/databases/site-1");
    status = 404;
    expect(await provisioner.findDatabase("site-1")).toBeNull();
    status = 500;
    await expect(provisioner.findDatabase("site-1")).rejects.toBeInstanceOf(TursoError);
  });

  it("reports Turso's error without the Platform token", async () => {
    const { provisioner } = fakeTurso(() => ({
      status: 409,
      json: { error: "database with name loc-abc already exists" },
    }));
    const error = await provisioner.create("abc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TursoError);
    expect((error as TursoError).status).toBe(409);
    expect(String(error)).toContain("already exists");
    expect(String(error)).not.toContain(API_TOKEN);
  });
});

describe("provisionerFromEnv", () => {
  it("uses local files only outside production, and Turso in production", () => {
    expect(provisionerFromEnv(".data/tenants", {})).toBeInstanceOf(LocalProvisioner);
    expect(() =>
      provisionerFromEnv(".data/tenants", { NODE_ENV: "production", LOCUS_PROVISIONER: "local" }),
    ).toThrow(/isolates nothing/);
    expect(() => provisionerFromEnv(".data/tenants", { NODE_ENV: "production" })).toThrow(
      /TURSO_ORG, TURSO_GROUP, TURSO_API_TOKEN not set/,
    );
    expect(
      provisionerFromEnv(".data/tenants", {
        NODE_ENV: "production",
        TURSO_ORG: "o",
        TURSO_GROUP: "g",
        TURSO_API_TOKEN: "t",
      }),
    ).toBeInstanceOf(TursoProvisioner);
    expect(() => provisionerFromEnv(".data/tenants", { LOCUS_PROVISIONER: "s3" })).toThrow();
  });
});
