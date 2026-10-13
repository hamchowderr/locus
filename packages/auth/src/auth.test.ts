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

describe("resetting a forgotten password", () => {
  const newPassword = "a brand new passphrase";
  const resetLink = (text: string | undefined) => new URL(text?.match(/https?:\/\/\S+/)?.[0] ?? "");
  const tokenIn = (text: string | undefined) => resetLink(text).pathname.split("/").at(-1) ?? "";

  async function verifiedOwner() {
    await auth.api.signUpEmail({ body: owner });
    await auth.api.verifyEmail({
      query: {
        token: new URL(sent[0]?.text.split(" ").at(-1) ?? "").searchParams.get("token") ?? "",
      },
    });
    sent = [];
  }

  it("emails the owner a link that leads back to the set-new-password page", async () => {
    await verifiedOwner();
    await auth.api.requestPasswordReset({
      body: { email: owner.email, redirectTo: "/reset-password" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(owner.email);
    const link = resetLink(sent[0]?.text);
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/\w+$/);
    expect(link.searchParams.get("callbackURL")).toBe("/reset-password");
  });

  it("answers the same for an unknown address and sends nothing", async () => {
    await expect(
      auth.api.requestPasswordReset({
        body: { email: "nobody@agency.test", redirectTo: "/reset-password" },
      }),
    ).resolves.toMatchObject({ status: true });
    expect(sent).toHaveLength(0);
  });

  it("sets the new password once, and only the new one signs in", async () => {
    await verifiedOwner();
    await auth.api.requestPasswordReset({ body: { email: owner.email } });
    const token = tokenIn(sent[0]?.text);

    await auth.api.resetPassword({ body: { token, newPassword } });
    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: owner.password } }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: newPassword } }),
    ).resolves.toBeTruthy();

    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "yet another passphrase" } }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
  });

  it("signs out every existing session", async () => {
    await verifiedOwner();
    await auth.api.signInEmail({ body: { email: owner.email, password: owner.password } });
    const context = await auth.$context;
    const user = await context.internalAdapter.findUserByEmail(owner.email);
    expect(await context.internalAdapter.listSessions(user?.user.id ?? "")).not.toEqual([]);

    await auth.api.requestPasswordReset({ body: { email: owner.email } });
    await auth.api.resetPassword({ body: { token: tokenIn(sent[0]?.text), newPassword } });

    expect(await context.internalAdapter.listSessions(user?.user.id ?? "")).toEqual([]);
  });

  it("verifies an owner whose verification email never arrived", async () => {
    await auth.api.signUpEmail({ body: owner });
    sent = [];
    await auth.api.requestPasswordReset({ body: { email: owner.email } });
    await auth.api.resetPassword({ body: { token: tokenIn(sent[0]?.text), newPassword } });

    const result = await auth.api.signInEmail({
      body: { email: owner.email, password: newPassword },
    });
    expect(result.user.emailVerified).toBe(true);
  });

  it("stops emailing one account after a few requests in an hour", async () => {
    await verifiedOwner();
    for (let i = 0; i < 6; i++) {
      await expect(
        auth.api.requestPasswordReset({ body: { email: owner.email } }),
      ).resolves.toMatchObject({ status: true });
    }
    expect(sent).toHaveLength(3);
  });

  it("refuses a made-up token", async () => {
    await expect(
      auth.api.resetPassword({ body: { token: "not-a-real-token", newPassword } }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
  });
});

describe("signing in", () => {
  async function verifiedOwner() {
    await auth.api.signUpEmail({ body: owner });
    await auth.api.verifyEmail({
      query: {
        token: new URL(sent[0]?.text.split(" ").at(-1) ?? "").searchParams.get("token") ?? "",
      },
    });
  }

  async function signIn() {
    const { headers } = await auth.api.signInEmail({
      body: { email: owner.email, password: owner.password },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return new Headers({ cookie });
  }

  it("reopens the agency the user already belongs to", async () => {
    await verifiedOwner();
    const first = await signIn();
    const agency = await auth.api.createOrganization({
      body: { name: "Acme Agency", slug: "acme-agency" },
      headers: first,
    });
    await auth.api.signOut({ headers: first });

    const again = await auth.api.getSession({ headers: await signIn() });
    expect(again?.session.activeOrganizationId).toBe(agency?.id);
  });

  it("leaves a user with no agency yet without one, so they get onboarding", async () => {
    await verifiedOwner();
    const current = await auth.api.getSession({ headers: await signIn() });
    expect(current?.session.activeOrganizationId ?? null).toBeNull();
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
