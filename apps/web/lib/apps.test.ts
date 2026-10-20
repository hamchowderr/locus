import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientAccessDenied, type SessionContext } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import { member, memberLocation, organization, user } from "@locus/db/control";
import type { AppConnections } from "@locus/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appConnectionsFromEnv,
  clientApps,
  connectClientApp,
  disconnectClientApp,
} from "./apps.ts";

let dir: string;
let db: ControlDb;
let clientA: string;
let clientB: string;
const now = new Date();

/** Composio, in memory: records which client each call was for. */
function fakeConnections() {
  const calls: string[] = [];
  const gmail = {
    toolkit: "gmail",
    name: "Gmail",
    description: "Email",
    logo: "",
    categories: [],
  };
  const connections: AppConnections = {
    catalog: async () => [gmail],
    list: async (clientId) => {
      calls.push(`list ${clientId}`);
      return [{ ...gmail, connected: false }];
    },
    connect: async (clientId, toolkit, callbackUrl) => {
      calls.push(`connect ${clientId} ${toolkit} ${callbackUrl}`);
      return "https://accounts.google.test/o";
    },
    disconnect: async (clientId, toolkit) => {
      calls.push(`disconnect ${clientId} ${toolkit}`);
    },
  };
  return { connections, calls };
}

const ctx = (userId: string, activeLocationId?: string): SessionContext => ({
  id: `s-${userId}`,
  userId,
  activeOrganizationId: "agency-a",
  ...(activeLocationId ? { activeLocationId } : {}),
});

async function addMember(userId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true });
  await db.insert(member).values({
    id: `${userId}@agency-a`,
    userId,
    organizationId: "agency-a",
    role,
    createdAt: now,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-web-apps-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  await db.insert(organization).values({ id: "agency-a", name: "A", slug: "a", createdAt: now });
  await addMember("owner", "owner");
  await addMember("staff", "member");
  const control = { control: db, provisioner: new LocalProvisioner(join(dir, "tenants")) };
  const provision = (ghlLocationId: string) =>
    provisionLocation(control, { organizationId: "agency-a", ghlLocationId, name: ghlLocationId });
  clientA = (await provision("ga")).id;
  clientB = (await provision("gb")).id;
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: clientA });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("connected apps", () => {
  it("lists the session's client's apps, and says who may change them", async () => {
    const { connections, calls } = fakeConnections();
    expect(await clientApps(db, ctx("owner", clientA), connections)).toMatchObject({
      manager: true,
    });
    expect(await clientApps(db, ctx("staff", clientA), connections)).toMatchObject({
      manager: false,
    });
    expect(calls).toEqual([`list ${clientA}`, `list ${clientA}`]);
  });

  it("an owner connects and disconnects apps for the session's client", async () => {
    const { connections, calls } = fakeConnections();
    const url = await connectClientApp(
      db,
      ctx("owner", clientB),
      connections,
      "gmail",
      "https://locus.test/apps",
    );
    await disconnectClientApp(db, ctx("owner", clientB), connections, "gmail");
    expect(url).toBe("https://accounts.google.test/o");
    expect(calls).toEqual([
      `connect ${clientB} gmail https://locus.test/apps`,
      `disconnect ${clientB} gmail`,
    ]);
  });

  it("a member can't change apps, and nothing reaches Composio", async () => {
    const { connections, calls } = fakeConnections();
    await expect(
      connectClientApp(db, ctx("staff", clientA), connections, "gmail", "https://x"),
    ).rejects.toThrow(ClientAccessDenied);
    await expect(
      disconnectClientApp(db, ctx("staff", clientA), connections, "gmail"),
    ).rejects.toThrow(ClientAccessDenied);
    expect(calls).toEqual([]);
  });

  it("a member restricted to one client can't see another's apps", async () => {
    const { connections, calls } = fakeConnections();
    await expect(clientApps(db, ctx("staff", clientB), connections)).rejects.toThrow(
      ClientAccessDenied,
    );
    expect(calls).toEqual([]);
  });

  it("is off until Otaku's Composio key is set", () => {
    expect(appConnectionsFromEnv({})).toBeNull();
    expect(appConnectionsFromEnv({ COMPOSIO_API_KEY: "k" })).not.toBeNull();
  });
});
