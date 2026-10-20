import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthorizedClient, ClientAccessDenied, type SessionContext } from "@locus/auth";
import { openClientDb } from "@locus/builder/host";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  openTenantDb,
  provisionLocation,
  readAppAccess,
} from "@locus/db";
import { location, member, memberLocation, organization, user } from "@locus/db/control";
import type { AppConnections } from "@locus/harness";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppAccessInputError,
  appConnectionsFromEnv,
  type ClientDbOpener,
  clientApps,
  connectClientApp,
  disconnectClientApp,
  setClientAppAccess,
} from "./apps.ts";

let dir: string;
let db: ControlDb;
let clientA: string;
let clientB: string;
let provisioner: LocalProvisioner;
/** Client databases opened, by client id: the staff check has run before each. */
let opened: string[];
const openDb: ClientDbOpener = (client: AuthorizedClient) => {
  opened.push(client.location.id);
  return openClientDb(provisioner, client);
};
const now = new Date();

/** A client's app settings, read straight from its own database. */
async function settingsOf(clientId: string) {
  const [loc] = await db.select().from(location).where(eq(location.id, clientId));
  if (!loc) throw new Error("no such client");
  const url = provisioner.url(loc.tursoDbHostname);
  const tenant = openTenantDb(url, await provisioner.mintToken(loc.tursoDbName));
  try {
    return await readAppAccess(tenant);
  } finally {
    tenant.$client.close();
  }
}

/** Composio, in memory: records which client each call was for. */
function fakeConnections(connected = false) {
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
      return [{ ...gmail, connected }];
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
  opened = [];
  provisioner = new LocalProvisioner(join(dir, "tenants"));
  const control = { control: db, provisioner };
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
    expect(await clientApps(db, ctx("owner", clientA), connections, openDb)).toMatchObject({
      manager: true,
    });
    expect(await clientApps(db, ctx("staff", clientA), connections, openDb)).toMatchObject({
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
    await disconnectClientApp(db, ctx("owner", clientB), connections, openDb, "gmail");
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
      disconnectClientApp(db, ctx("staff", clientA), connections, openDb, "gmail"),
    ).rejects.toThrow(ClientAccessDenied);
    expect(calls).toEqual([]);
  });

  it("a member restricted to one client can't see another's apps", async () => {
    const { connections, calls } = fakeConnections();
    await expect(clientApps(db, ctx("staff", clientB), connections, openDb)).rejects.toThrow(
      ClientAccessDenied,
    );
    expect(calls).toEqual([]);
  });

  it("a connected app starts with the default, read from the client's own database", async () => {
    const { connections } = fakeConnections(true);
    const { apps } = await clientApps(db, ctx("staff", clientA), connections, openDb);
    expect(apps).toEqual([expect.objectContaining({ toolkit: "gmail", access: "ask_changes" })]);
    expect(opened).toEqual([clientA]);
  });

  it("with nothing connected, the client's database isn't opened", async () => {
    const { connections } = fakeConnections(false);
    await clientApps(db, ctx("owner", clientA), connections, openDb);
    expect(opened).toEqual([]);
  });

  it("an owner sets how the chat uses an app, in the session's client's own database", async () => {
    await setClientAppAccess(db, ctx("owner", clientB), openDb, "Gmail", "off");
    expect(await settingsOf(clientB)).toEqual({ gmail: "off" });
    expect(await settingsOf(clientA)).toEqual({});
    const { connections } = fakeConnections(true);
    const { apps } = await clientApps(db, ctx("owner", clientB), connections, openDb);
    expect(apps).toEqual([expect.objectContaining({ toolkit: "gmail", access: "off" })]);

    await setClientAppAccess(db, ctx("owner", clientB), openDb, "gmail", "allow");
    expect(await settingsOf(clientB)).toEqual({ gmail: "allow" });
  });

  it("a member can't change a setting, and the client's database isn't opened", async () => {
    await expect(
      setClientAppAccess(db, ctx("staff", clientA), openDb, "gmail", "allow"),
    ).rejects.toThrow(ClientAccessDenied);
    // Nor for a client they can't work on at all.
    await expect(
      setClientAppAccess(db, ctx("staff", clientB), openDb, "gmail", "allow"),
    ).rejects.toThrow(ClientAccessDenied);
    expect(opened).toEqual([]);
    expect(await settingsOf(clientA)).toEqual({});
  });

  it("only Locus's settings and real app names are saved", async () => {
    const tries: [string, string][] = [
      ["gmail", "always"],
      ["gmail", ""],
      ["../gmail", "off"],
      ["", "off"],
    ];
    for (const [toolkit, access] of tries) {
      await expect(
        setClientAppAccess(db, ctx("owner", clientA), openDb, toolkit, access),
      ).rejects.toThrow(AppAccessInputError);
    }
    expect(opened).toEqual([]);
  });

  it("disconnecting an app forgets its setting, so connecting it again starts afresh", async () => {
    const { connections } = fakeConnections(true);
    await setClientAppAccess(db, ctx("owner", clientA), openDb, "gmail", "off");
    await setClientAppAccess(db, ctx("owner", clientA), openDb, "slack", "ask");
    await disconnectClientApp(db, ctx("owner", clientA), connections, openDb, "gmail");
    expect(await settingsOf(clientA)).toEqual({ slack: "ask" });
  });

  it("is off until Otaku's Composio key is set", () => {
    expect(appConnectionsFromEnv({})).toBeNull();
    expect(appConnectionsFromEnv({ COMPOSIO_API_KEY: "k" })).not.toBeNull();
  });
});
