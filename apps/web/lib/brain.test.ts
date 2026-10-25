import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthorizedClient, authorizeClient, type SessionContext } from "@locus/auth";
import { AGENT_ACTOR, BrainFilesystem } from "@locus/brain";
import { closeClientDbs, openClientDb } from "@locus/builder/host";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import { member, organization, user } from "@locus/db/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrainDeps,
  BrainInputError,
  brainNote,
  brainOverview,
  changedBy,
  createBrainNote,
  deleteBrainNote,
  newNotePath,
  restoreBrainNote,
  saveBrainNote,
} from "./brain.ts";

let dir: string;
let db: ControlDb;
let provisioner: LocalProvisioner;
let deps: BrainDeps;
let clientA: AuthorizedClient;
let clientB: AuthorizedClient;
const now = new Date();
const ctx: SessionContext = { id: "s-owner", userId: "owner", activeOrganizationId: "agency-a" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-brain-web-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  provisioner = new LocalProvisioner(join(dir, "tenants"));
  deps = { openClientDb: (client) => openClientDb(provisioner, client) };
  await db.insert(organization).values({ id: "agency-a", name: "A", slug: "a", createdAt: now });
  await db
    .insert(user)
    .values({ id: "owner", name: "owner", email: "owner@agency.test", emailVerified: true });
  await db.insert(member).values({
    id: "owner@agency-a",
    userId: "owner",
    organizationId: "agency-a",
    role: "owner",
    createdAt: now,
  });
  const control = { control: db, provisioner };
  const a = await provisionLocation(control, {
    organizationId: "agency-a",
    ghlLocationId: "ga",
    name: "A",
  });
  const b = await provisionLocation(control, {
    organizationId: "agency-a",
    ghlLocationId: "gb",
    name: "B",
  });
  clientA = await authorizeClient(db, ctx, a.id);
  clientB = await authorizeClient(db, ctx, b.id);
});

afterEach(async () => {
  closeClientDbs();
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the brain as people see it", () => {
  it("lists every folder in order, with the client's own notes only", async () => {
    await saveBrainNote(deps, clientA, "owner", "/business/hours.md", "# Hours\n\nOpen 8 to 5.");
    await saveBrainNote(deps, clientB, "owner", "business/prices.md", "# Prices\n\nFrom $90.");
    const { instructions, folders } = await brainOverview(deps, clientA);
    expect(instructions).toBeNull();
    expect(folders.map((f) => f.name)).toEqual([
      "business",
      "people",
      "playbooks",
      "work",
      "decisions",
      "sources",
      "inbox",
    ]);
    expect(folders[0]?.notes).toMatchObject([
      { path: "business/hours.md", name: "hours", summary: "Open 8 to 5." },
    ]);
  });

  it("saves as the person, and a change can be put back, as a new version", async () => {
    const agent = new BrainFilesystem(await deps.openClientDb(clientA), { actor: AGENT_ACTOR });
    await agent.writeFile("/business/hours.md", "# Hours\n\nOpen 8 to 5.");
    await saveBrainNote(deps, clientA, "owner", "business/hours.md", "# Hours\r\n\r\nOpen 9 to 5.");

    let note = await brainNote(deps, clientA, "business/hours.md");
    expect(note?.content).toBe("# Hours\n\nOpen 9 to 5.");
    expect(note?.versions.map((v) => [v.number, v.createdBy])).toEqual([
      [2, "user:owner"],
      [1, AGENT_ACTOR],
    ]);
    expect(changedBy(note?.updatedBy ?? null, "owner")).toBe("You");
    expect(changedBy(AGENT_ACTOR, "owner")).toBe("The agent");
    expect(changedBy("user:maria", "owner")).toBe("Someone on your team");

    await restoreBrainNote(deps, clientA, "owner", "business/hours.md", 1);
    note = await brainNote(deps, clientA, "business/hours.md");
    expect(note?.content).toContain("Open 8 to 5.");
    expect(note?.versions).toHaveLength(3);
    await expect(restoreBrainNote(deps, clientA, "owner", "business/hours.md", 9)).rejects.toThrow(
      BrainInputError,
    );
  });

  it("deletes a note and brings it back from its history", async () => {
    await saveBrainNote(deps, clientA, "owner", "playbooks/follow-ups.md", "# Follow-ups\n\nText.");
    await deleteBrainNote(deps, clientA, "owner", "playbooks/follow-ups.md");
    let note = await brainNote(deps, clientA, "playbooks/follow-ups.md");
    expect(note?.content).toBeNull();
    expect((await brainOverview(deps, clientA)).folders[2]?.notes).toEqual([]);
    await expect(
      deleteBrainNote(deps, clientA, "owner", "playbooks/follow-ups.md"),
    ).rejects.toThrow(BrainInputError);

    await restoreBrainNote(deps, clientA, "owner", "playbooks/follow-ups.md", 1);
    note = await brainNote(deps, clientA, "playbooks/follow-ups.md");
    expect(note?.content).toContain("Text.");
  });

  it("starts a note from a folder and a name, and never over one that exists", async () => {
    expect(newNotePath("business", "Opening Hours!")).toBe("business/opening-hours.md");
    expect(() => newNotePath("customers", "x")).toThrow(BrainInputError);
    expect(() => newNotePath("business", "  ")).toThrow(BrainInputError);

    const path = await createBrainNote(deps, clientA, "owner", "business", "Opening hours");
    expect((await brainNote(deps, clientA, path))?.content).toBe("# Opening hours\n\n");
    await saveBrainNote(deps, clientA, "owner", path, "# Opening hours\n\nKept.");
    await expect(
      createBrainNote(deps, clientA, "owner", "business", "Opening hours"),
    ).rejects.toThrow(BrainInputError);
    expect((await brainNote(deps, clientA, path))?.content).toContain("Kept.");
  });

  it("refuses paths that aren't notes in a folder", async () => {
    for (const bad of ["index.md", "../x.md", "customers/jane.md", "business", "notes.md"]) {
      await expect(saveBrainNote(deps, clientA, "owner", bad, "x")).rejects.toThrow(
        BrainInputError,
      );
    }
    await saveBrainNote(deps, clientA, "owner", "instructions.md", "Ask Maria first.");
    expect((await brainOverview(deps, clientA)).instructions?.summary).toBe("Ask Maria first.");
    expect(await brainNote(deps, clientA, "business/missing.md")).toBeNull();
  });
});
