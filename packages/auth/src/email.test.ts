import { describe, expect, it, vi } from "vitest";
import { consoleEmail, emailFromEnv } from "./email.ts";

const message = { to: "a@agency.test", subject: "Hi", text: "Open https://x.test/verify" };

describe("emailFromEnv", () => {
  it("prints to the console by default outside production", () => {
    expect(emailFromEnv({})).toBe(consoleEmail);
    expect(emailFromEnv({ NODE_ENV: "development" })).toBe(consoleEmail);
  });

  it("refuses to guess in production", () => {
    expect(() => emailFromEnv({ NODE_ENV: "production" })).toThrow(/EMAIL_MODE/);
    expect(() => emailFromEnv({ EMAIL_MODE: "smtp" })).toThrow(/EMAIL_MODE/);
  });

  it("refuses console mode in production, keeps it elsewhere", () => {
    expect(() => emailFromEnv({ NODE_ENV: "production", EMAIL_MODE: "console" })).toThrow(
      /EMAIL_MODE=console is refused in production/,
    );
    expect(emailFromEnv({ NODE_ENV: "development", EMAIL_MODE: "console" })).toBe(consoleEmail);
    expect(emailFromEnv({ NODE_ENV: "test", EMAIL_MODE: "console" })).toBe(consoleEmail);
  });

  it("uses Resend in production when configured", () => {
    const env = {
      NODE_ENV: "production",
      EMAIL_MODE: "resend",
      RESEND_API_KEY: "k",
      EMAIL_FROM: "x@y.test",
    };
    expect(emailFromEnv(env)).not.toBe(consoleEmail);
  });

  it("needs a key and a sender for Resend", () => {
    expect(() => emailFromEnv({ EMAIL_MODE: "resend", RESEND_API_KEY: "k" })).toThrow(/EMAIL_FROM/);
  });

  it("sends through Resend's API and fails loudly when refused", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = emailFromEnv(
      { EMAIL_MODE: "resend", RESEND_API_KEY: "key", EMAIL_FROM: "Locus <no-reply@x.test>" },
      fetchImpl as unknown as typeof fetch,
    );
    await send(message);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Locus <no-reply@x.test>",
      to: ["a@agency.test"],
      subject: "Hi",
      text: message.text,
    });
    expect(new Headers(init.headers).has("idempotency-key")).toBe(false);

    // A message sent "once" carries its key, so Resend drops a repeat.
    await send({ ...message, idempotencyKey: "app-expired/msg_1/a@agency.test" });
    const [, keyed] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(keyed.headers).get("idempotency-key")).toBe(
      "app-expired/msg_1/a@agency.test",
    );

    fetchImpl.mockResolvedValueOnce(new Response("bad sender", { status: 422 }));
    await expect(send(message)).rejects.toThrow(/422 bad sender/);
  });
});
