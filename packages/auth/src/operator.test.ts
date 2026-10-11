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
import { agencyComp, auditLog, member, organization, user } from "@locus/db/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionContext } from "./client-access.ts";
import {
  isComped,
  isOperator,
  listAgencies,
  NotOperator,
  operatorsFromEnv,
  setComped,
} from "./operator.ts";

let dir: string;
let db: ControlDb;
const OPERATORS = ["ops@deploy.test"];
const ctx = (userId: string): SessionContext => ({ id: `s-${userId}`, userId });

async function person(id: string, email: string, emailVerified = true) {
  await db.insert(user).values({ id, name: id, email, emailVerified });
}
async function agency(id: string, ownerId: string, createdAt: Date) {
  await db.insert(organization).values({ id, name: `Agency ${id}`, slug: id, createdAt });
  await db.insert(member).values({
    id: `${ownerId}@${id}`,
    userId: ownerId,
    organizationId: id,
    role: "owner",
    createdAt,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-operator-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  await person("ops", "Ops@Deploy.test");
  await person("unverified", "ops2@deploy.test", false);
  await person("owner-a", "a@agency.test");
  await person("owner-b", "b@agency.test");
  await agency("a", "owner-a", new Date("2026-10-01"));
  await agency("b", "owner-b", new Date("2026-10-05"));
  await provisionLocation(
    { control: db, provisioner: new LocalProvisioner(join(dir, "tenants")), migrations: [] },
    { organizationId: "a", ghlLocationId: "loc-1", name: "Client 1" },
  );
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("operators", () => {
  it("are the deployment's own list of emails", () => {
    expect(operatorsFromEnv({ LOCUS_OPERATORS: " Ops@Deploy.test, x@y.test ,," })).toEqual([
      "ops@deploy.test",
      "x@y.test",
    ]);
    expect(operatorsFromEnv({})).toEqual([]);
  });

  it("must be listed and verified; no list means no operators", async () => {
    expect(await isOperator(db, ctx("ops"), OPERATORS)).toBe(true);
    expect(await isOperator(db, ctx("owner-a"), OPERATORS)).toBe(false);
    expect(await isOperator(db, ctx("ops"), [])).toBe(false);
    await db.insert(user).values({
      id: "imposter",
      name: "imposter",
      email: "OPS@deploy.TEST.",
      emailVerified: true,
    });
    expect(await isOperator(db, ctx("imposter"), OPERATORS)).toBe(false);
    expect(await isOperator(db, ctx("unverified"), ["ops2@deploy.test"])).toBe(false);
  });

  it("see every agency with its owners, clients and comp state, newest first", async () => {
    expect(await listAgencies(db, ctx("ops"), OPERATORS)).toEqual([
      expect.objectContaining({
        id: "b",
        ownerEmails: ["b@agency.test"],
        clients: 0,
        comped: false,
      }),
      expect.objectContaining({
        id: "a",
        ownerEmails: ["a@agency.test"],
        clients: 1,
        comped: false,
      }),
    ]);
  });

  it("comp and uncomp an agency, each change in the audit log", async () => {
    await setComped(db, ctx("ops"), OPERATORS, "a", true);
    expect(await isComped(db, "a")).toBe(true);
    expect(await isComped(db, "b")).toBe(false);
    await setComped(db, ctx("ops"), OPERATORS, "a", true); // again: no error, still one row
    expect(await db.select().from(agencyComp)).toHaveLength(1);
    await setComped(db, ctx("ops"), OPERATORS, "a", false);
    expect(await isComped(db, "a")).toBe(false);
    const trail = await db.select().from(auditLog);
    expect(trail.map((r) => [r.organizationId, r.actorUserId, r.action])).toEqual([
      ["a", "ops", "operator.comp"],
      ["a", "ops", "operator.comp"],
      ["a", "ops", "operator.uncomp"],
    ]);
  });

  it("everyone else is refused, including an agency owner comping their own agency", async () => {
    await expect(listAgencies(db, ctx("owner-a"), OPERATORS)).rejects.toBeInstanceOf(NotOperator);
    await expect(setComped(db, ctx("owner-a"), OPERATORS, "a", true)).rejects.toBeInstanceOf(
      NotOperator,
    );
    expect(await isComped(db, "a")).toBe(false);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("can't comp an agency that doesn't exist", async () => {
    await expect(setComped(db, ctx("ops"), OPERATORS, "nope", true)).rejects.toBeInstanceOf(
      NotOperator,
    );
  });
});
