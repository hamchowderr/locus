import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentToWebKey, chatKitKey, mintAgentToWebToken } from "@locus/auth";
import {
  type ControlDb,
  LocalProvisioner,
  migrateControlDb,
  openControlDb,
  provisionLocation,
} from "@locus/db";
import { member, memberLocation, organization, site, user } from "@locus/db/control";
import { FakeRuntimeProvider, RemoteRuntimeProvider, RemoteSandboxError } from "@locus/sandbox";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxRpcHandler } from "./sandbox-rpc.ts";

const SECRET = "test-auth-secret";
const URL_ = "https://locus.test/api/internal/sandbox";
const now = new Date();

let dir: string;
let db: ControlDb;
let runtimes: FakeRuntimeProvider;
let clientA: string;
let clientB: string;

async function addMember(userId: string, organizationId: string, role: string) {
  await db
    .insert(user)
    .values({ id: userId, name: userId, email: `${userId}@agency.test`, emailVerified: true });
  await db
    .insert(member)
    .values({ id: `${userId}@${organizationId}`, userId, organizationId, role, createdAt: now });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-web-sandbox-rpc-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  const provisioner = new LocalProvisioner(join(dir, "tenants"));
  runtimes = new FakeRuntimeProvider();
  await db.insert(organization).values([
    { id: "agency-a", name: "A", slug: "a", createdAt: now },
    { id: "agency-b", name: "B", slug: "b", createdAt: now },
  ]);
  await addMember("owner", "agency-a", "owner");
  await addMember("staff", "agency-a", "member");
  await addMember("outsider", "agency-b", "owner");
  const control = { control: db, provisioner };
  clientA = (
    await provisionLocation(control, {
      organizationId: "agency-a",
      ghlLocationId: "ga",
      name: "A1",
    })
  ).id;
  clientB = (
    await provisionLocation(control, {
      organizationId: "agency-a",
      ghlLocationId: "gb",
      name: "B1",
    })
  ).id;
  await db.insert(memberLocation).values({ memberId: "staff@agency-a", locationId: clientA });
  await db.insert(site).values([
    { id: "site-a", locationId: clientA },
    { id: "site-b", locationId: clientB },
  ]);
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const handler = () => sandboxRpcHandler({ db, provider: runtimes, authSecret: SECRET });

function remoteFor(token: string | (() => string)) {
  const handle = handler();
  return new RemoteRuntimeProvider({
    url: URL_,
    mintToken: typeof token === "string" ? () => token : token,
    fetch: async (input, init) => handle(new Request(input, init)),
  });
}

const tokenFor = (
  memberId: string,
  locationId: string,
  organizationId = "agency-a",
  key = agentToWebKey(SECRET),
) => mintAgentToWebToken(key, { memberId, locationId, organizationId });

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error) => {
      if (!(error instanceof RemoteSandboxError)) throw error;
      return error.status;
    },
  );

describe("/api/internal/sandbox", () => {
  it("opens the token's client's site under the in-process builder's key", async () => {
    const runtime = await remoteFor(tokenFor("staff@agency-a", clientA)).open("site-a");
    await runtime.writeFiles([{ path: "app/page.tsx", content: "export default 1" }]);
    expect([...runtimes.runtimes.keys()]).toEqual([`${clientA}/site-a`]);
    expect(runtimes.runtimes.get(`${clientA}/site-a`)?.readText("app/page.tsx")).toBe(
      "export default 1",
    );
    expect(await runtime.startPreview()).toEqual({
      url: `https://preview.fake/${clientA}/site-a`,
    });
  });

  it("refuses a token signed with another label or secret, or valid over 10 minutes (404)", async () => {
    expect(
      await status(
        remoteFor(tokenFor("owner@agency-a", clientA, "agency-a", chatKitKey(SECRET))).open(
          "site-a",
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        remoteFor(tokenFor("owner@agency-a", clientA, "agency-a", agentToWebKey("other"))).open(
          "site-a",
        ),
      ),
    ).toBe(404);
    // Hand-signed with exp 11 minutes out: mintAgentToWebToken refuses to make one.
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 11 * 60;
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "owner@agency-a", loc: clientA, org: "agency-a", aud: "locus-web", exp })}`;
    const long = `${body}.${createHmac("sha256", agentToWebKey(SECRET)).update(body).digest("base64url")}`;
    expect(await status(remoteFor(long).open("site-a"))).toBe(404);
    expect(runtimes.runtimes.size).toBe(0);
  });

  it("refuses a restricted staff member on a client not on their list (403)", async () => {
    expect(await status(remoteFor(tokenFor("staff@agency-a", clientB)).open("site-b"))).toBe(403);
    expect(runtimes.runtimes.size).toBe(0);
  });

  it("refuses a site of another client (403), whatever the token's client", async () => {
    expect(await status(remoteFor(tokenFor("staff@agency-a", clientA)).open("site-b"))).toBe(403);
    expect(await status(remoteFor(tokenFor("owner@agency-a", clientA)).open("site-b"))).toBe(403);
    expect(await status(remoteFor(tokenFor("owner@agency-a", clientA)).open("no-such"))).toBe(403);
    expect(runtimes.runtimes.size).toBe(0);
  });

  it("refuses a member of another agency, or one claiming another agency (403)", async () => {
    expect(
      await status(remoteFor(tokenFor("outsider@agency-b", clientA, "agency-b")).open("site-a")),
    ).toBe(403);
    expect(
      await status(remoteFor(tokenFor("outsider@agency-b", clientA, "agency-a")).open("site-a")),
    ).toBe(403);
    expect(runtimes.runtimes.size).toBe(0);
  });

  it("checks again on every call: removed access stops the next one", async () => {
    const remote = remoteFor(() => tokenFor("staff@agency-a", clientA));
    const runtime = await remote.open("site-a");
    await db.delete(memberLocation).where(eq(memberLocation.memberId, "staff@agency-a"));
    expect(await status(runtime.run("ls"))).toBe(403);
    await db.delete(member).where(eq(member.id, "owner@agency-a"));
    expect(await status(remoteFor(tokenFor("owner@agency-a", clientA)).open("site-a"))).toBe(403);
  });
});
