import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import { location, member, organization, user } from "@locus/db/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tellExpiredApp } from "./app-expired.ts";

let dir: string;
let db: ControlDb;
let sent: { to: string; subject: string; text: string }[];
const now = new Date();

async function addMember(agency: string, userId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true });
  await db
    .insert(member)
    .values({ id: `${userId}@${agency}`, userId, organizationId: agency, role, createdAt: now });
}

async function addClient(agency: string, id: string, status: "active" | "offboarding" = "active") {
  await db.insert(location).values({
    id,
    organizationId: agency,
    ghlLocationId: `ghl-${id}`,
    name: `Client ${id}`,
    tursoDbName: `db-${id}`,
    tursoDbHostname: `db-${id}.turso.test`,
    status,
  });
}

const deps = () => ({
  db,
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
  },
  baseUrl: "https://locus.test",
  appName: async (toolkit: string) => (toolkit === "slack" ? "Slack" : undefined),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-web-expired-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  sent = [];
  for (const id of ["agency-a", "agency-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
  }
  await addMember("agency-a", "owner", "owner");
  await addMember("agency-a", "admin", "member,admin");
  await addMember("agency-a", "staff", "member");
  await addMember("agency-b", "other", "owner");
  await addClient("agency-a", "c1");
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("an app's sign-in expired", () => {
  it("emails the client's agency owners and admins, naming the client and the app", async () => {
    expect(await tellExpiredApp(deps(), { clientId: "c1", toolkit: "slack" })).toEqual({
      told: 2,
    });
    expect(sent.map((m) => m.to).sort()).toEqual(["admin@agency.test", "owner@agency.test"]);
    expect(sent[0]?.subject).toBe("Slack needs signing in again for Client c1");
    expect(sent[0]?.text).toContain("Client c1 (agency-a)");
    expect(sent[0]?.text).toContain("https://locus.test/apps");
  });

  it("names the app by its slug when its name isn't known", async () => {
    await tellExpiredApp(deps(), { clientId: "c1", toolkit: "notion" });
    expect(sent[0]?.subject).toBe("notion needs signing in again for Client c1");
  });

  it("tells nobody about a client this deployment doesn't have, or one being removed", async () => {
    await addClient("agency-a", "c2", "offboarding");
    expect(await tellExpiredApp(deps(), { clientId: "nope", toolkit: "slack" })).toBe(
      "unknown client",
    );
    expect(await tellExpiredApp(deps(), { clientId: "c2", toolkit: "slack" })).toBe(
      "unknown client",
    );
    expect(sent).toEqual([]);
  });
});
