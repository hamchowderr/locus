import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import * as schema from "@locus/db/control";
import { location, member, memberLocation, organization, session, user } from "@locus/db/control";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import {
  type AuthorizedClient,
  authorizeClient,
  ClientAccessDenied,
  listAccessibleClients,
  mintClientDbToken,
  resolveActiveClient,
  type SessionContext,
  selectClient,
} from "./client-access.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
const now = new Date();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-access-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "tenants"));
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

async function agency(id: string) {
  await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
}
async function person(id: string) {
  await db.insert(user).values({ id, name: id, email: `${id}@agency.test`, emailVerified: true });
}
async function addMember(userId: string, organizationId: string, role: string) {
  const id = `${userId}@${organizationId}`;
  await db.insert(member).values({ id, userId, organizationId, role, createdAt: now });
  return id;
}
async function client(organizationId: string, ghlLocationId: string) {
  const { id } = await provisionLocation(
    { control: db, provisioner, migrations: [] },
    { organizationId, ghlLocationId, name: ghlLocationId },
  );
  return id;
}
async function signedIn(userId: string, activeOrganizationId: string): Promise<SessionContext> {
  const id = `session-${userId}`;
  await db.insert(session).values({
    id,
    userId,
    token: `token-${userId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: now,
    activeOrganizationId,
  });
  return { id, userId, activeOrganizationId };
}

const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ClientAccessDenied);

describe("staff client access", () => {
  let a1: string;
  let a2: string;
  let b1: string;

  beforeEach(async () => {
    await agency("agency-a");
    await agency("agency-b");
    for (const u of ["owner", "staff", "both"]) await person(u);
    await addMember("owner", "agency-a", "owner");
    const staff = await addMember("staff", "agency-a", "member");
    await addMember("both", "agency-a", "member");
    await addMember("both", "agency-b", "admin");
    a1 = await client("agency-a", "ghl-a1");
    a2 = await client("agency-a", "ghl-a2");
    b1 = await client("agency-b", "ghl-b1");
    await db.insert(memberLocation).values({ memberId: staff, locationId: a1 });
  });

  it("lets an owner work on every client of their agency", async () => {
    const ctx = await signedIn("owner", "agency-a");
    expect((await authorizeClient(db, ctx, a1)).location.id).toBe(a1);
    expect((await authorizeClient(db, ctx, a2)).location.id).toBe(a2);
    expect((await listAccessibleClients(db, ctx)).map((l) => l.id).sort()).toEqual([a1, a2].sort());
  });

  it("restricts a member to their list, with a 403 on any other client", async () => {
    const ctx = await signedIn("staff", "agency-a");
    expect((await authorizeClient(db, ctx, a1)).location.id).toBe(a1);
    const error = await authorizeClient(db, ctx, a2).catch((e) => e);
    expect(error).toBeInstanceOf(ClientAccessDenied);
    expect(error.status).toBe(403);
    expect((await listAccessibleClients(db, ctx)).map((l) => l.id)).toEqual([a1]);
  });

  it("gives a member with no list no clients, not all of them", async () => {
    const ctx = await signedIn("both", "agency-a");
    await denied(authorizeClient(db, ctx, a1));
    expect(await listAccessibleClients(db, ctx)).toEqual([]);
  });

  it("never reaches another agency's client by naming its id, even for a member of both", async () => {
    const inA = await signedIn("both", "agency-a");
    await denied(authorizeClient(db, inA, b1));
    const owner = await signedIn("owner", "agency-a");
    await denied(authorizeClient(db, owner, b1));
    // Same message either way: the response must not reveal that the client exists.
    const foreign = await authorizeClient(db, owner, b1).catch((e) => e.message);
    const missing = await authorizeClient(db, owner, "no-such-client").catch((e) => e.message);
    expect(foreign).toBe(missing);
  });

  it("refuses a session with no active agency, or one the user isn't a member of", async () => {
    await denied(authorizeClient(db, { id: "s", userId: "owner" }, a1));
    await denied(
      authorizeClient(db, { id: "s", userId: "staff", activeOrganizationId: "agency-b" }, b1),
    );
  });

  it("refuses clients that are not active", async () => {
    const ctx = await signedIn("owner", "agency-a");
    await db.update(location).set({ status: "suspended" }).where(eq(location.id, a2));
    await denied(authorizeClient(db, ctx, a2));
    expect((await listAccessibleClients(db, ctx)).map((l) => l.id)).toEqual([a1]);
  });

  it("selects a client into the session and re-checks it on every use", async () => {
    const ctx = await signedIn("staff", "agency-a");
    await denied(selectClient(db, ctx, a2));
    await selectClient(db, ctx, a1);
    const [row] = await db.select().from(session).where(eq(session.id, ctx.id));
    expect(row?.activeLocationId).toBe(a1);

    const active = { ...ctx, activeLocationId: row?.activeLocationId };
    expect((await resolveActiveClient(db, active)).location.id).toBe(a1);
    // The owner takes the client off this member's list: the next request is refused.
    await db.delete(memberLocation).where(eq(memberLocation.locationId, a1));
    await denied(resolveActiveClient(db, active));
  });

  it("mints a database token only for a client that passed the check", async () => {
    const ctx = await signedIn("staff", "agency-a");
    const authorized = await authorizeClient(db, ctx, a1);
    await expect(mintClientDbToken(provisioner, authorized, { ttl: "10m" })).resolves.toBeTypeOf(
      "string",
    );
    const forged = { location: authorized.location, memberId: "x" } as AuthorizedClient;
    await denied(mintClientDbToken(provisioner, forged, { ttl: "10m" }));
  });
});

describe("Better Auth session", () => {
  it("carries activeLocationId, empty until a client is selected", async () => {
    const sent: string[] = [];
    const auth = createAuth({
      db,
      schema,
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-0000",
      sendEmail: async ({ text }) => {
        sent.push(text);
      },
    });
    const body = { name: "Owner", email: "o@agency.test", password: "correct horse battery" };
    await auth.api.signUpEmail({ body });
    const token = new URL(sent[0]?.split(" ").at(-1) ?? "").searchParams.get("token") ?? "";
    await auth.api.verifyEmail({ query: { token } });
    const { headers } = await auth.api.signInEmail({
      body: { email: body.email, password: body.password },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(current?.session).toHaveProperty("activeLocationId");
    expect(current?.session.activeLocationId ?? null).toBeNull();
  });
});
