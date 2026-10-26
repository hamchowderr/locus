import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import * as schema from "@locus/db/control";
import { agencyComp, invitation, member, subscription, user } from "@locus/db/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import { seatRefusal, startTrial } from "./billing.ts";

let dir: string;
let db: ControlDb;
let sent: { to: string; text: string }[];

const auth = (billing: boolean) =>
  createAuth({
    db,
    schema,
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-0000",
    sendEmail: async (message) => {
      sent.push(message);
    },
    ...(billing
      ? { billing: { secretKey: "sk_test_never_called", webhookSecret: "whsec_test" } }
      : {}),
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-seats-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  sent = [];
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** A verified owner, signed in, with an agency of their own. */
async function ownerWithAgency(a: ReturnType<typeof createAuth>) {
  const owner = { name: "Owner", email: "owner@agency.test", password: "correct horse battery" };
  await a.api.signUpEmail({ body: owner });
  const token = new URL(sent[0]?.text.split(" ").at(-1) ?? "").searchParams.get("token") ?? "";
  await a.api.verifyEmail({ query: { token } });
  const signedIn = await a.api.signInEmail({
    body: { email: owner.email, password: owner.password },
    returnHeaders: true,
  });
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  const headers = new Headers({ cookie });
  const agency = await a.api.createOrganization({
    body: { name: "Agency", slug: "agency" },
    headers,
  });
  if (!agency) throw new Error("no agency");
  return { headers, agencyId: agency.id, userId: signedIn.response.user.id };
}

async function addPeople(organizationId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db
      .insert(user)
      .values({ id: `u${i}`, name: `U${i}`, email: `u${i}@agency.test`, emailVerified: true });
    await db.insert(member).values({
      id: `m${i}`,
      userId: `u${i}`,
      organizationId,
      role: "member",
      createdAt: new Date(),
    });
  }
}

describe("a plan's seats", () => {
  it("count people and open invitations; an accepted one already holds its seat", async () => {
    const a = auth(true);
    const { agencyId, userId } = await ownerWithAgency(a);
    await db.insert(subscription).values({
      id: "sub",
      plan: "growth",
      referenceId: agencyId,
      status: "active",
    });
    // Growth has 3 seats: the owner and one more person leave one.
    await addPeople(agencyId, 1);
    expect(await seatRefusal(db, agencyId)).toBeNull();
    await db.insert(invitation).values({
      id: "inv",
      organizationId: agencyId,
      email: "new@agency.test",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: userId,
      createdAt: new Date(),
    });
    expect(await seatRefusal(db, agencyId)).toMatch(/Growth plan includes 3 seats/);
    // The invited person may still join: their seat is the one the invitation holds.
    expect(await seatRefusal(db, agencyId, { accepting: true })).toBeNull();
    // An expired invitation holds nothing.
    expect(
      await seatRefusal(db, agencyId, { now: new Date(Date.now() + 2 * 86_400_000) }),
    ).toBeNull();
  });

  it("refuses an invitation once the free trial's one seat is taken, until comped", async () => {
    const a = auth(true);
    const { headers, agencyId, userId } = await ownerWithAgency(a);
    await startTrial(db, agencyId, userId);
    await expect(
      a.api.createInvitation({ body: { email: "new@agency.test", role: "member" }, headers }),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: expect.stringMatching(/free trial includes 1 seat, and it's taken/) },
    });
    await db.insert(agencyComp).values({ organizationId: agencyId, compedByUserId: "ops" });
    await expect(
      a.api.createInvitation({ body: { email: "new@agency.test", role: "member" }, headers }),
    ).resolves.toMatchObject({ email: "new@agency.test" });
  });

  it("are never checked where billing is off", async () => {
    const a = auth(false);
    const { headers, agencyId, userId } = await ownerWithAgency(a);
    await startTrial(db, agencyId, userId);
    await expect(
      a.api.createInvitation({ body: { email: "new@agency.test", role: "member" }, headers }),
    ).resolves.toMatchObject({ email: "new@agency.test" });
  });
});
