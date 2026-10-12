import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDb, migrateControlDb, openControlDb } from "@locus/db";
import * as schema from "@locus/db/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";

let dir: string;
let db: ControlDb;
let sent: { to: string; subject: string; text: string }[];
let auth: ReturnType<typeof createAuth>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "locus-auth-"));
  db = openControlDb(`file:${join(dir, "control.db")}`);
  await migrateControlDb(db);
  sent = [];
  auth = createAuth({
    db,
    schema,
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-0000",
    sendEmail: async (message) => {
      sent.push(message);
    },
  });
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const owner = { name: "Owner", email: "owner@agency.test", password: "correct horse battery" };

describe("email verification is mandatory", () => {
  it("sends a verification email on sign-up and refuses sign-in until it is used", async () => {
    await auth.api.signUpEmail({ body: owner });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(owner.email);
    expect(sent[0]?.text).toContain("/verify-email?token=");

    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: owner.password } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("lets a verified user sign in", async () => {
    await auth.api.signUpEmail({ body: owner });
    const token = new URL(sent[0]?.text.split(" ").at(-1) ?? "").searchParams.get("token");
    await auth.api.verifyEmail({ query: { token: token ?? "" } });

    const result = await auth.api.signInEmail({
      body: { email: owner.email, password: owner.password },
    });
    expect(result.user.emailVerified).toBe(true);
  });
});

describe("a sign-up whose verification email failed", () => {
  // The first send fails, as it did on a deployment with email misconfigured; later ones work.
  async function failedSignUp() {
    let failNext = true;
    auth = createAuth({
      db,
      schema,
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-0000",
      sendEmail: async (message) => {
        if (failNext) {
          failNext = false;
          throw new Error("the mail provider refused it");
        }
        sent.push(message);
      },
    });
    await auth.api.signUpEmail({ body: owner });
    expect(sent).toHaveLength(0);
  }

  const linkIn = (text: string | undefined) =>
    new URL(text?.split(" ").at(-1) ?? "").searchParams.get("token") ?? "";

  it("gets a fresh link when the owner signs up again, and that link works", async () => {
    await failedSignUp();
    await auth.api.signUpEmail({ body: owner });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(owner.email);

    await auth.api.verifyEmail({ query: { token: linkIn(sent[0]?.text) } });
    const result = await auth.api.signInEmail({
      body: { email: owner.email, password: owner.password },
    });
    expect(result.user.emailVerified).toBe(true);
  });

  it("gets a fresh link when the owner signs in with the right password", async () => {
    await failedSignUp();
    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: owner.password } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("/verify-email?token=");
  });

  it("sends nothing for a wrong password", async () => {
    await failedSignUp();
    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: "not the password" } }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(sent).toHaveLength(0);
  });
});

describe("signing up with an address that is already verified", () => {
  it("answers as for a new address and sends nothing", async () => {
    await auth.api.signUpEmail({ body: owner });
    await auth.api.verifyEmail({
      query: {
        token: new URL(sent[0]?.text.split(" ").at(-1) ?? "").searchParams.get("token") ?? "",
      },
    });
    sent = [];

    await expect(auth.api.signUpEmail({ body: owner })).resolves.toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});

describe("generated schema", () => {
  it("matches what the auth CLI emits for this config (run `pnpm --filter @locus/auth generate:schema`)", async () => {
    const out = join(dir, "auth-schema.ts");
    execFileSync(
      "pnpm",
      ["exec", "auth", "generate", "--config", "src/cli-config.ts", "--output", out, "--yes"],
      { cwd: join(import.meta.dirname, ".."), stdio: "pipe" },
    );
    const committed = await readFile(
      join(import.meta.dirname, "../../db/src/control/auth-schema.ts"),
      "utf8",
    );
    expect(await readFile(out, "utf8")).toBe(committed);
  }, 60_000);
});
